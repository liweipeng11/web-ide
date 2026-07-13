import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);
const configCache = new Map<string, { mtimeMs: number; options: ts.CompilerOptions }>();

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

function isInsideWorkspace(workspaceRoot: string, targetPath: string) {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** 查找源文件最近的 tsconfig，确保 monorepo 子项目使用自己的路径别名配置。 */
export function findCompilerConfig(workspaceRoot: string, fromFile: string) {
  let directory = path.dirname(path.resolve(workspaceRoot, fromFile));
  const root = path.resolve(workspaceRoot);

  while (isInsideWorkspace(root, directory)) {
    const configPath = path.join(directory, "tsconfig.json");
    if (ts.sys.fileExists(configPath)) return configPath;
    if (directory === root) break;
    directory = path.dirname(directory);
  }

  return undefined;
}

export function loadCompilerOptions(workspaceRoot: string, fromFile: string): ts.CompilerOptions {
  const configPath = findCompilerConfig(workspaceRoot, fromFile);
  if (configPath) {
    const mtimeMs = ts.sys.getModifiedTime?.(configPath)?.getTime() || 0;
    const cached = configCache.get(configPath);
    if (cached?.mtimeMs === mtimeMs) return cached.options;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config || {}, ts.sys, path.dirname(configPath));
    configCache.set(configPath, { mtimeMs, options: parsed.options });
    return parsed.options;
  }

  return {
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022
  };
}

/** 使用 TypeScript 自身的模块解析能力支持相对路径、paths、baseUrl 和包导出。 */
export async function resolveWorkspaceModule(workspaceRoot: string, fromFile: string, specifier: string) {
  const absoluteFrom = path.resolve(workspaceRoot, fromFile);
  const options = loadCompilerOptions(workspaceRoot, fromFile);
  let resolved = ts.resolveModuleName(specifier, absoluteFrom, options, ts.sys).resolvedModule?.resolvedFileName;
  if (!resolved && specifier.startsWith(".")) {
    const basePath = path.resolve(path.dirname(absoluteFrom), specifier);
    const extension = path.extname(basePath);
    const candidates = extension ? [basePath] : [basePath, ...[...SOURCE_EXTENSIONS].map((item) => `${basePath}${item}`), ...[...SOURCE_EXTENSIONS].map((item) => path.join(basePath, `index${item}`))];
    for (const candidate of candidates) {
      const stat = await fs.stat(candidate).catch(() => null);
      if (stat?.isFile()) {
        resolved = candidate;
        break;
      }
    }
  }
  if (!resolved) return undefined;

  // pnpm workspace 包可能先解析到符号链接，取真实路径后再判断是否属于当前工作区。
  const realPath = await fs.realpath(resolved).catch(() => resolved);
  if (!isInsideWorkspace(workspaceRoot, realPath)) return undefined;
  const extension = path.extname(realPath).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(extension) || realPath.endsWith(".d.ts")) return undefined;
  return toPosix(path.relative(path.resolve(workspaceRoot), realPath));
}
