import fs from "node:fs/promises";
import path from "node:path";
import { resolvePathAlias } from "./aliasResolver.js";
import { resolvePackageImport } from "./packageResolver.js";
import type {
  ExistenceCandidate,
  ExistenceCheckResult,
  ExistenceCheckTarget,
  ExistenceCheckerResult,
  ExistenceStatus,
  ImportReference,
  ReferenceResolution,
  ReferenceResolutionStatus
} from "./types.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs", ".py"];
const IMPORT_EXTENSIONS = ["", ...SOURCE_EXTENSIONS, ".json"];
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", ".mini-ai", ".ai-agent"]);
const MAX_SOURCE_FILES = 1_500;

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function toLegacyStatus(status: ReferenceResolutionStatus): ExistenceStatus {
  if (status === "existing" || status === "dependency_installed" || status === "planned_create") return "exists";
  if (status === "ambiguous" || status === "unknown") return "ambiguous";
  return "missing";
}

function createResult(
  target: ExistenceCheckTarget,
  status: ReferenceResolutionStatus,
  candidates: ExistenceCandidate[],
  reason: string,
  extras: Pick<ReferenceResolution, "blocking" | "packageRoot" | "resolvedPath"> = { blocking: status !== "existing" && status !== "dependency_installed" && status !== "planned_create" }
): ExistenceCheckResult {
  const resolution: ReferenceResolution = {
    status,
    blocking: extras.blocking,
    reason,
    candidates,
    ...(extras.packageRoot !== undefined ? { packageRoot: extras.packageRoot } : {}),
    ...(extras.resolvedPath !== undefined ? { resolvedPath: extras.resolvedPath } : {})
  };
  return {
    target: { ...target, value: target.value.trim(), ...(target.fromPath ? { fromPath: normalizeRelativePath(target.fromPath) } : {}) },
    status: toLegacyStatus(status),
    candidates,
    reason,
    resolution
  };
}

function createResultFromResolution(target: ExistenceCheckTarget, resolution: ReferenceResolution) {
  return createResult(target, resolution.status, resolution.candidates, resolution.reason, {
    blocking: resolution.blocking,
    ...(resolution.packageRoot !== undefined ? { packageRoot: resolution.packageRoot } : {}),
    ...(resolution.resolvedPath !== undefined ? { resolvedPath: resolution.resolvedPath } : {})
  });
}

async function pathExists(targetPath: string) {
  return fs.stat(targetPath).then(() => true).catch(() => false);
}

async function collectFiles(workspaceRoot: string, predicate: (relativePath: string) => boolean) {
  const files: string[] = [];

  async function visit(directory: string) {
    if (files.length >= MAX_SOURCE_FILES) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) return;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
      if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      if (entry.isFile() && predicate(relativePath)) files.push(relativePath);
    }
  }

  await visit(workspaceRoot);
  return files.sort((left, right) => left.localeCompare(right));
}

function resolveFromPath(workspaceRoot: string, fromPath?: string) {
  return fromPath ? path.dirname(path.resolve(workspaceRoot, fromPath)) : workspaceRoot;
}

function isInsideWorkspace(workspaceRoot: string, absolutePath: string) {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

async function resolveFileCandidates(workspaceRoot: string, basePath: string, detail: string) {
  const candidates: ExistenceCandidate[] = [];
  if (!isInsideWorkspace(workspaceRoot, basePath)) return candidates;
  for (const extension of IMPORT_EXTENSIONS) {
    const filePath = `${basePath}${extension}`;
    if (await pathExists(filePath)) candidates.push({ path: normalizeRelativePath(path.relative(workspaceRoot, filePath)), detail });
  }
  for (const extension of IMPORT_EXTENSIONS.slice(1)) {
    const filePath = path.join(basePath, `index${extension}`);
    if (await pathExists(filePath)) candidates.push({ path: normalizeRelativePath(path.relative(workspaceRoot, filePath)), detail: `${detail}（目录 index）` });
  }
  return candidates;
}

/** 提取 JavaScript/TypeScript 静态 import，作为生成或写入前的最后一道路径核验依据。 */
export function extractImportReferences(content: string): ImportReference[] {
  const references: ImportReference[] = [];
  const expression = /import\s+(?:([\s\S]*?)\s+from\s+)?["']([^"']+)["']|export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;

  while ((match = expression.exec(content))) {
    const clause = (match[1] || "").trim();
    const specifier = match[2] || match[3];
    const symbols = clause
      .match(/\{([^}]*)\}/)?.[1]
      ?.split(",")
      .map((item) => item.trim().split(/\s+as\s+/i)[0])
      .filter(Boolean) || [];
    if (specifier && !references.some((reference) => reference.specifier === specifier)) references.push({ specifier, symbols });
  }

  return references;
}

/** 校验一段将要写入工作区的代码中的所有静态 import。 */
export async function checkCodeImports(workspaceRoot: string, content: string, fromPath: string) {
  const references = extractImportReferences(content);
  const result = await checkExistence(
    workspaceRoot,
    references.map((reference) => ({ kind: "import" as const, value: reference.specifier, fromPath }))
  );
  return { references, result };
}

async function checkImport(workspaceRoot: string, target: ExistenceCheckTarget) {
  const specifier = target.value.trim();
  if (!specifier) return createResult(target, "truly_missing", [], "import 路径不能为空");

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const basePath = specifier.startsWith("/") ? path.resolve(workspaceRoot, `.${specifier}`) : path.resolve(resolveFromPath(workspaceRoot, target.fromPath), specifier);
    if (!isInsideWorkspace(workspaceRoot, basePath)) {
      return createResult(target, "unknown", [], "import 路径试图越出工作区，已阻止解析", { blocking: true });
    }
    const candidates = await resolveFileCandidates(workspaceRoot, basePath, "相对 import 目标");
    return candidates.length === 1
      ? createResult(target, "existing", candidates, "import 路径已解析到唯一文件", { blocking: false, resolvedPath: candidates[0].path })
      : candidates.length > 1
        ? createResult(target, "ambiguous", candidates, "import 路径可解析到多个文件，请明确扩展名或路径")
        : createResult(target, "truly_missing", [], "未找到 import 路径对应的文件或目录 index 文件");
  }

  const aliasResolution = await resolvePathAlias({ workspaceRoot, specifier, ...(target.fromPath ? { fromPath: target.fromPath } : {}) });
  if (aliasResolution) return createResultFromResolution(target, aliasResolution);

  const packageResolution = await resolvePackageImport({ workspaceRoot, specifier, ...(target.fromPath ? { fromPath: target.fromPath } : {}) });
  return createResultFromResolution(target, packageResolution);
}

function symbolExpression(symbol: string) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b|export\\s*\\{[^}]*\\b${escaped}\\b`, "m");
}

async function checkSymbol(workspaceRoot: string, target: ExistenceCheckTarget) {
  const symbol = target.value.trim();
  if (!symbol) return createResult(target, "truly_missing", [], "符号名称不能为空");
  const expression = symbolExpression(symbol);
  const files = target.fromPath ? [normalizeRelativePath(target.fromPath)] : await collectFiles(workspaceRoot, (filePath) => SOURCE_EXTENSIONS.includes(path.extname(filePath).toLowerCase()));
  const candidates: ExistenceCandidate[] = [];
  for (const filePath of files) {
    const content = await fs.readFile(path.join(workspaceRoot, filePath), "utf8").catch(() => "");
    const pythonExpression = new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m");
    const vueComponentName = path.extname(filePath).toLowerCase() === ".vue" && path.basename(filePath, ".vue") === symbol;
    if (expression.test(content) || pythonExpression.test(content) || vueComponentName) candidates.push({ path: filePath, detail: `定义或导出符号 ${symbol}` });
  }
  return candidates.length === 1
    ? createResult(target, "existing", candidates, "符号定义唯一", { blocking: false, resolvedPath: candidates[0].path })
    : candidates.length > 1
      ? createResult(target, "ambiguous", candidates, "发现多个同名符号，请指定定义文件")
      : createResult(target, "truly_missing", [], "未找到符号定义或导出");
}

async function checkScript(workspaceRoot: string, target: ExistenceCheckTarget) {
  const requestedPath = target.fromPath ? normalizeRelativePath(target.fromPath) : "package.json";
  const raw = await fs.readFile(path.join(workspaceRoot, requestedPath), "utf8").catch(() => "");
  try {
    const packageJson = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (typeof packageJson.scripts?.[target.value.trim()] === "string") return createResult(target, "existing", [{ path: requestedPath, detail: `scripts.${target.value.trim()}` }], "package.json 脚本已定义", { blocking: false, resolvedPath: requestedPath });
  } catch {
    return createResult(target, "truly_missing", [], "未找到可解析的 package.json");
  }
  return createResult(target, "truly_missing", [], "package.json 中未定义该脚本");
}

async function checkEnvironment(workspaceRoot: string, target: ExistenceCheckTarget) {
  const variableName = target.value.trim();
  const envFiles = await collectFiles(workspaceRoot, (filePath) => path.posix.basename(filePath).startsWith(".env"));
  const expression = new RegExp(`^\\s*(?:export\\s+)?${variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`, "m");
  const candidates: ExistenceCandidate[] = [];
  for (const filePath of envFiles) {
    const content = await fs.readFile(path.join(workspaceRoot, filePath), "utf8").catch(() => "");
    if (expression.test(content)) candidates.push({ path: filePath, detail: `定义环境变量 ${variableName}` });
  }
  const activeCandidates = candidates.filter((candidate) => !path.posix.basename(candidate.path).includes("example"));
  const effectiveCandidates = activeCandidates.length ? activeCandidates : candidates;
  if (effectiveCandidates.length === 1) return createResult(target, "existing", effectiveCandidates, activeCandidates.length ? "环境变量具有有效配置来源" : "环境变量仅在示例配置中定义", { blocking: false, resolvedPath: effectiveCandidates[0].path });
  if (effectiveCandidates.length > 1) return createResult(target, "ambiguous", effectiveCandidates, "多个有效环境文件定义了该变量，请确认加载优先级");
  return createResult(target, "truly_missing", [], "未在 .env 类文件中找到环境变量定义");
}

async function checkDirectory(workspaceRoot: string, target: ExistenceCheckTarget) {
  const directoryPath = path.resolve(workspaceRoot, target.value.trim());
  if (!isInsideWorkspace(workspaceRoot, directoryPath)) return createResult(target, "unknown", [], "目录路径超出工作区，已阻止解析");
  const stat = await fs.stat(directoryPath).catch(() => null);
  return stat?.isDirectory()
    ? createResult(target, "existing", [{ path: normalizeRelativePath(path.relative(workspaceRoot, directoryPath)), detail: "目录已存在" }], "目录真实存在", { blocking: false, resolvedPath: normalizeRelativePath(path.relative(workspaceRoot, directoryPath)) })
    : createResult(target, "truly_missing", [], "目录不存在或目标不是目录");
}

/** 在实际工作区中核验 Agent 即将引用的路径、符号、脚本与配置来源。 */
export async function checkExistence(workspaceRoot: string, targets: ExistenceCheckTarget[]): Promise<ExistenceCheckerResult> {
  const checks = await Promise.all(
    targets.map(async (target) => {
      if (target.kind === "import") return checkImport(workspaceRoot, target);
      if (target.kind === "symbol") return checkSymbol(workspaceRoot, target);
      if (target.kind === "script") return checkScript(workspaceRoot, target);
      if (target.kind === "environment") return checkEnvironment(workspaceRoot, target);
      return checkDirectory(workspaceRoot, target);
    })
  );
  return {
    checks,
    summary: checks.reduce((summary, check) => ({ ...summary, [check.status]: summary[check.status] + 1 }), { exists: 0, missing: 0, ambiguous: 0 })
  };
}
