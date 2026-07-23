import fs from "node:fs/promises";
import path from "node:path";
import type { ExistenceCandidate, ReferenceResolution } from "./types.js";

export type AliasResolverOptions = {
  workspaceRoot: string;
  specifier: string;
  fromPath?: string;
};

type JsonConfig = {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
};

const IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs", ".json"];

function normalizePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readJson(filePath: string): Promise<JsonConfig | null> {
  const content = await fs.readFile(filePath, "utf8").catch(() => "");
  try {
    return content ? JSON.parse(stripTrailingCommas(stripJsonComments(content))) as JsonConfig : null;
  } catch {
    return null;
  }
}

/** tsconfig/jsconfig 允许 JSONC；这里只移除字符串之外的注释，不执行配置代码。 */
function stripJsonComments(content: string) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    const next = content[index + 1];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === "\"") inString = false;
      continue;
    }
    if (current === "\"") {
      inString = true;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < content.length && !(content[index] === "*" && content[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

function stripTrailingCommas(content: string) {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index];
    if (inString) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === "\"") inString = false;
      continue;
    }
    if (current === "\"") {
      inString = true;
      result += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(content[lookahead] || "")) lookahead += 1;
      if (content[lookahead] === "}" || content[lookahead] === "]") continue;
    }
    result += current;
  }
  return result;
}

async function pathExists(filePath: string) {
  return fs.stat(filePath).then(() => true).catch(() => false);
}

async function resolveFileCandidates(workspaceRoot: string, basePath: string, detail: string) {
  if (!isInside(workspaceRoot, basePath)) return { escaped: true, candidates: [] as ExistenceCandidate[] };
  const candidates: ExistenceCandidate[] = [];
  for (const extension of IMPORT_EXTENSIONS) {
    const filePath = `${basePath}${extension}`;
    if (await pathExists(filePath)) candidates.push({ path: normalizePath(path.relative(workspaceRoot, filePath)), detail });
  }
  for (const extension of IMPORT_EXTENSIONS.slice(1)) {
    const filePath = path.join(basePath, `index${extension}`);
    if (await pathExists(filePath)) candidates.push({ path: normalizePath(path.relative(workspaceRoot, filePath)), detail: `${detail}（目录 index）` });
  }
  return {
    escaped: false,
    candidates: candidates.filter((candidate, index, all) => all.findIndex((item) => item.path === candidate.path) === index)
  };
}

function ancestorDirectories(workspaceRoot: string, startDirectory: string) {
  const directories: string[] = [];
  let current = startDirectory;
  while (isInside(workspaceRoot, current)) {
    directories.push(current);
    if (path.resolve(current) === path.resolve(workspaceRoot)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

function matchAlias(pattern: string, specifier: string) {
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex < 0) return specifier === pattern ? "" : null;
  const prefix = pattern.slice(0, wildcardIndex);
  const suffix = pattern.slice(wildcardIndex + 1);
  return specifier.startsWith(prefix) && specifier.endsWith(suffix)
    ? specifier.slice(prefix.length, specifier.length - suffix.length)
    : null;
}

function extractStaticAliases(content: string) {
  const aliases: Array<{ alias: string; target: string }> = [];
  const aliasBlock = content.match(/\balias\s*:\s*\{([\s\S]*?)\}/)?.[1];
  if (aliasBlock) {
    const pairExpression = /(?:["']([^"']+)["']|([A-Za-z_$][\w$@.-]*))\s*:\s*(?:path\.resolve\(\s*__dirname\s*,\s*)?["']([^"']+)["']\s*\)?/g;
    let pair: RegExpExecArray | null;
    while ((pair = pairExpression.exec(aliasBlock))) aliases.push({ alias: pair[1] || pair[2], target: pair[3] });
  }
  const setExpression = /\.set\(\s*["']([^"']+)["']\s*,\s*(?:path\.resolve\(\s*__dirname\s*,\s*)?["']([^"']+)["']\s*\)?\s*\)/g;
  let setMatch: RegExpExecArray | null;
  while ((setMatch = setExpression.exec(content))) aliases.push({ alias: setMatch[1], target: setMatch[2] });
  const arrayExpression = /\bfind\s*:\s*["']([^"']+)["']\s*,\s*replacement\s*:\s*(?:path\.resolve\(\s*__dirname\s*,\s*)?["']([^"']+)["']\s*\)?/g;
  let arrayMatch: RegExpExecArray | null;
  while ((arrayMatch = arrayExpression.exec(content))) aliases.push({ alias: arrayMatch[1], target: arrayMatch[2] });
  const relevantBlock = aliasBlock || content.match(/\balias\s*:\s*\[([\s\S]*?)\]/)?.[1] || "";
  const dynamic = /\.\.\.|\[[^\]]+\]\s*:|=>|\bfunction\b|\bprocess\.|\bimport\.meta\b/.test(relevantBlock)
    || (/\balias\b/.test(content) && !aliases.length);
  return { aliases, dynamic };
}

async function nearestPackageRoot(workspaceRoot: string, ancestors: string[]) {
  for (const directory of ancestors) {
    if (await pathExists(path.join(directory, "package.json"))) return directory;
  }
  return workspaceRoot;
}

function makeResolution(
  status: ReferenceResolution["status"],
  blocking: boolean,
  reason: string,
  candidates: ExistenceCandidate[],
  packageRoot?: string
): ReferenceResolution {
  return {
    status,
    blocking,
    reason,
    candidates,
    ...(packageRoot ? { packageRoot: normalizePath(packageRoot) } : {}),
    ...(candidates.length === 1 ? { resolvedPath: candidates[0].path } : {})
  };
}

/**
 * 仅静态读取别名配置，不执行 vue.config 或 vite.config 中的任何代码。
 */
export async function resolvePathAlias(options: AliasResolverOptions): Promise<ReferenceResolution | null> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const fromAbsolutePath = path.resolve(workspaceRoot, options.fromPath || "package.json");
  if (!isInside(workspaceRoot, fromAbsolutePath)) {
    return makeResolution("unknown", true, "引用发起路径超出工作区，已阻止别名解析", []);
  }
  const ancestors = ancestorDirectories(workspaceRoot, path.dirname(fromAbsolutePath));
  const packageRoot = await nearestPackageRoot(workspaceRoot, ancestors);

  for (const configName of ["tsconfig.json", "jsconfig.json"]) {
    for (const directory of ancestors) {
      const config = await readJson(path.join(directory, configName));
      const optionsValue = config?.compilerOptions;
      if (!optionsValue?.paths) continue;
      for (const [alias, targets] of Object.entries(optionsValue.paths)) {
        const wildcard = matchAlias(alias, options.specifier);
        if (wildcard === null) continue;
        const resolvedGroups = await Promise.all(targets.map((target) => {
          const substituted = target.includes("*") ? target.replaceAll("*", wildcard) : target;
          return resolveFileCandidates(workspaceRoot, path.resolve(directory, optionsValue.baseUrl || ".", substituted), `${configName} 路径别名`);
        }));
        if (resolvedGroups.some((group) => group.escaped)) {
          return makeResolution("unknown", true, `${configName} 别名目标超出工作区`, [], path.relative(workspaceRoot, packageRoot));
        }
        const candidates = resolvedGroups.flatMap((group) => group.candidates);
        if (candidates.length === 1) return makeResolution("existing", false, `import 已通过 ${configName} 路径别名解析`, candidates, path.relative(workspaceRoot, packageRoot));
        if (candidates.length > 1) return makeResolution("ambiguous", true, `${configName} 路径别名解析到多个候选`, candidates, path.relative(workspaceRoot, packageRoot));
        return makeResolution("truly_missing", true, `${configName} 已声明该别名，但目标不存在`, [], path.relative(workspaceRoot, packageRoot));
      }
    }
  }

  // Vue CLI 默认提供 @ -> 当前包 src；只在具有 package.json 和 src 的包边界启用。
  if (options.specifier === "@" || options.specifier.startsWith("@/")) {
    const sourceRoot = path.join(packageRoot, "src");
    if (await pathExists(sourceRoot)) {
      const suffix = options.specifier === "@" ? "" : options.specifier.slice(2);
      const resolved = await resolveFileCandidates(workspaceRoot, path.join(sourceRoot, suffix), "Vue CLI 默认 @ 别名");
      if (resolved.candidates.length === 1) return makeResolution("existing", false, "import 已通过 Vue CLI 默认 @ 别名解析", resolved.candidates, path.relative(workspaceRoot, packageRoot));
      if (resolved.candidates.length > 1) return makeResolution("ambiguous", true, "Vue CLI 默认 @ 别名解析到多个候选", resolved.candidates, path.relative(workspaceRoot, packageRoot));
      return makeResolution("truly_missing", true, "Vue CLI 默认 @ 别名目标不存在", [], path.relative(workspaceRoot, packageRoot));
    }
  }

  for (const configName of ["vue.config.js", "vite.config.ts", "vite.config.js"]) {
    for (const directory of ancestors) {
      const content = await fs.readFile(path.join(directory, configName), "utf8").catch(() => "");
      if (!content) continue;
      const extracted = extractStaticAliases(content);
      for (const alias of extracted.aliases) {
        if (options.specifier !== alias.alias && !options.specifier.startsWith(`${alias.alias}/`)) continue;
        const suffix = options.specifier.slice(alias.alias.length).replace(/^\//, "");
        const targetBase = path.resolve(directory, alias.target, suffix);
        const resolved = await resolveFileCandidates(workspaceRoot, targetBase, `${configName} 静态别名`);
        if (resolved.escaped) return makeResolution("unknown", true, `${configName} 别名目标超出工作区`, [], path.relative(workspaceRoot, packageRoot));
        if (resolved.candidates.length === 1) return makeResolution("existing", false, `import 已通过 ${configName} 静态别名解析`, resolved.candidates, path.relative(workspaceRoot, packageRoot));
        if (resolved.candidates.length > 1) return makeResolution("ambiguous", true, `${configName} 静态别名解析到多个候选`, resolved.candidates, path.relative(workspaceRoot, packageRoot));
        return makeResolution("truly_missing", true, `${configName} 已声明该别名，但目标不存在`, [], path.relative(workspaceRoot, packageRoot));
      }
      if (extracted.dynamic && /^(?:@|#|~|\$)[^/]*\//.test(options.specifier)) {
        return makeResolution("unknown", true, `${configName} 包含无法安全静态确认的动态 alias`, [], path.relative(workspaceRoot, packageRoot));
      }
    }
  }

  return null;
}
