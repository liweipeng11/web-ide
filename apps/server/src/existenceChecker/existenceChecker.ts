import fs from "node:fs/promises";
import path from "node:path";
import type { ExistenceCandidate, ExistenceCheckResult, ExistenceCheckTarget, ExistenceCheckerResult, ExistenceStatus, ImportReference } from "./types.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs", ".py"];
const IMPORT_EXTENSIONS = ["", ...SOURCE_EXTENSIONS, ".json"];
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", ".mini-ai", ".ai-agent"]);
const MAX_SOURCE_FILES = 1_500;

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function createResult(target: ExistenceCheckTarget, status: ExistenceStatus, candidates: ExistenceCandidate[], reason: string): ExistenceCheckResult {
  return { target: { ...target, value: target.value.trim(), ...(target.fromPath ? { fromPath: normalizeRelativePath(target.fromPath) } : {}) }, status, candidates, reason };
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

async function readJson<T>(filePath: string): Promise<T | null> {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  try {
    return content ? (JSON.parse(content) as T) : null;
  } catch {
    return null;
  }
}

async function resolveTsPathAliases(workspaceRoot: string, specifier: string) {
  const tsconfigPaths = await collectFiles(workspaceRoot, (filePath) => path.posix.basename(filePath) === "tsconfig.json");
  const bases: string[] = [];
  for (const tsconfigPath of tsconfigPaths) {
    const config = await readJson<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(path.join(workspaceRoot, tsconfigPath));
    const options = config?.compilerOptions;
    if (!options?.paths) continue;
    const configDirectory = path.dirname(path.join(workspaceRoot, tsconfigPath));
    for (const [alias, targets] of Object.entries(options.paths)) {
      const wildcardIndex = alias.indexOf("*");
      const matches = wildcardIndex === -1 ? specifier === alias : specifier.startsWith(alias.slice(0, wildcardIndex)) && specifier.endsWith(alias.slice(wildcardIndex + 1));
      if (!matches) continue;
      const wildcardValue = wildcardIndex === -1 ? "" : specifier.slice(alias.slice(0, wildcardIndex).length, specifier.length - alias.slice(wildcardIndex + 1).length);
      for (const target of targets) bases.push(path.resolve(configDirectory, options.baseUrl || ".", target.replace("*", wildcardValue)));
    }
  }
  return bases;
}

function uniqueCandidates(candidates: ExistenceCandidate[]) {
  return candidates.filter((candidate, index) => candidates.findIndex((item) => item.path === candidate.path) === index);
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
  if (!specifier) return createResult(target, "missing", [], "import 路径不能为空");

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const basePath = specifier.startsWith("/") ? path.resolve(workspaceRoot, `.${specifier}`) : path.resolve(resolveFromPath(workspaceRoot, target.fromPath), specifier);
    const candidates = await resolveFileCandidates(workspaceRoot, basePath, "相对 import 目标");
    return candidates.length === 1
      ? createResult(target, "exists", candidates, "import 路径已解析到唯一文件")
      : candidates.length > 1
        ? createResult(target, "ambiguous", candidates, "import 路径可解析到多个文件，请明确扩展名或路径")
        : createResult(target, "missing", [], "未找到 import 路径对应的文件或目录 index 文件");
  }

  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  const packageJsonPaths = await collectFiles(workspaceRoot, (filePath) => path.posix.basename(filePath) === "package.json");
  const subpath = specifier.slice(packageName.length).replace(/^\//, "");
  const aliasBases = await resolveTsPathAliases(workspaceRoot, specifier);
  const aliasCandidates = uniqueCandidates((await Promise.all(aliasBases.map((basePath) => resolveFileCandidates(workspaceRoot, basePath, "tsconfig 路径别名目标")))).flat());
  if (aliasCandidates.length) return aliasCandidates.length === 1 ? createResult(target, "exists", aliasCandidates, "import 已通过 tsconfig 路径别名解析") : createResult(target, "ambiguous", aliasCandidates, "路径别名解析到多个候选文件");

  const candidates: ExistenceCandidate[] = [];
  const declaredPackages: ExistenceCandidate[] = [];
  for (const packageJsonPath of packageJsonPaths) {
    const absolutePackageJsonPath = path.join(workspaceRoot, packageJsonPath);
    const packageJson = await readJson<{ name?: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }>(absolutePackageJsonPath);
    if (!packageJson) continue;
    if (packageJson.name === packageName) {
      const packageDirectory = path.dirname(absolutePackageJsonPath);
      const workspaceCandidates = subpath ? await resolveFileCandidates(workspaceRoot, path.join(packageDirectory, subpath), "工作区包子路径") : [{ path: packageJsonPath, detail: "工作区包定义" }];
      candidates.push(...workspaceCandidates);
    }
    if (packageJson.dependencies?.[packageName] || packageJson.devDependencies?.[packageName]) declaredPackages.push({ path: packageJsonPath, detail: `声明依赖 ${packageName}` });
  }
  const installDirectories = [path.join(workspaceRoot, "node_modules", packageName), path.join(resolveFromPath(workspaceRoot, target.fromPath), "node_modules", packageName)];
  for (const installDirectory of [...new Set(installDirectories)]) {
    const manifest = await readJson<{ name?: string }>(path.join(installDirectory, "package.json"));
    if (!manifest?.name) continue;
    const installedCandidates = subpath ? await resolveFileCandidates(workspaceRoot, path.join(installDirectory, subpath), "已安装包子路径") : [{ path: normalizeRelativePath(path.relative(workspaceRoot, path.join(installDirectory, "package.json"))), detail: "已安装包" }];
    candidates.push(...installedCandidates);
  }
  const resolvedCandidates = uniqueCandidates(candidates);
  if (resolvedCandidates.length === 1) return createResult(target, "exists", resolvedCandidates, "import 包或子路径真实存在");
  if (resolvedCandidates.length > 1) return createResult(target, "ambiguous", resolvedCandidates, "import 包解析到多个候选，请指定所属工作区包");
  if (declaredPackages.length) return createResult(target, "missing", declaredPackages, "package.json 已声明依赖，但未解析到已安装包或子路径");
  return createResult(target, "missing", [], "未找到 import 包、工作区包或路径别名目标");
}

function symbolExpression(symbol: string) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b|export\\s*\\{[^}]*\\b${escaped}\\b`, "m");
}

async function checkSymbol(workspaceRoot: string, target: ExistenceCheckTarget) {
  const symbol = target.value.trim();
  if (!symbol) return createResult(target, "missing", [], "符号名称不能为空");
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
    ? createResult(target, "exists", candidates, "符号定义唯一")
    : candidates.length > 1
      ? createResult(target, "ambiguous", candidates, "发现多个同名符号，请指定定义文件")
      : createResult(target, "missing", [], "未找到符号定义或导出");
}

async function checkScript(workspaceRoot: string, target: ExistenceCheckTarget) {
  const requestedPath = target.fromPath ? normalizeRelativePath(target.fromPath) : "package.json";
  const raw = await fs.readFile(path.join(workspaceRoot, requestedPath), "utf8").catch(() => "");
  try {
    const packageJson = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (typeof packageJson.scripts?.[target.value.trim()] === "string") return createResult(target, "exists", [{ path: requestedPath, detail: `scripts.${target.value.trim()}` }], "package.json 脚本已定义");
  } catch {
    return createResult(target, "missing", [], "未找到可解析的 package.json");
  }
  return createResult(target, "missing", [], "package.json 中未定义该脚本");
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
  if (effectiveCandidates.length === 1) return createResult(target, "exists", effectiveCandidates, activeCandidates.length ? "环境变量具有有效配置来源" : "环境变量仅在示例配置中定义");
  if (effectiveCandidates.length > 1) return createResult(target, "ambiguous", effectiveCandidates, "多个有效环境文件定义了该变量，请确认加载优先级");
  return createResult(target, "missing", [], "未在 .env 类文件中找到环境变量定义");
}

async function checkDirectory(workspaceRoot: string, target: ExistenceCheckTarget) {
  const directoryPath = path.resolve(workspaceRoot, target.value.trim());
  const stat = await fs.stat(directoryPath).catch(() => null);
  return stat?.isDirectory()
    ? createResult(target, "exists", [{ path: normalizeRelativePath(path.relative(workspaceRoot, directoryPath)), detail: "目录已存在" }], "目录真实存在")
    : createResult(target, "missing", [], "目录不存在或目标不是目录");
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
