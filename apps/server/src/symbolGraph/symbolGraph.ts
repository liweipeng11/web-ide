import fs from "node:fs/promises";
import path from "node:path";
import { findCompilerConfig, resolveWorkspaceModule } from "./moduleResolver.js";
import { bindSemanticReferences } from "./semanticResolver.js";
import { parseSourceFile } from "./sourceParser.js";
import type { BuildSymbolGraphOptions, ParsedSourceFile, SymbolDefinition, SymbolGraph } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", ".mini-ai", ".mini-ai-web-editor"]);
const DEFAULT_MAX_FILES = 1_500;
const MAX_FILES = 5_000;
const parseCache = new Map<string, { mtimeMs: number; size: number; parsed: ParsedSourceFile }>();
const graphCache = new Map<string, { signature: string; graph: SymbolGraph }>();

function toPosix(value: string) {
  return value.split(path.sep).join("/");
}

function normalizeStartPath(workspaceRoot: string, targetPath = "") {
  if (path.isAbsolute(targetPath)) throw new Error("Symbol Graph path must be workspace-relative");
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, targetPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Symbol Graph path is outside workspace");
  return resolved;
}

async function collectSourceFiles(workspaceRoot: string, options: BuildSymbolGraphOptions) {
  const maxFiles = Math.min(Math.max(options.maxFiles || DEFAULT_MAX_FILES, 1), MAX_FILES);
  const startPath = normalizeStartPath(workspaceRoot, options.path);
  const stat = await fs.stat(startPath).catch(() => null);
  if (!stat) throw new Error("Symbol Graph path not found");
  if (stat.isFile()) return { files: SUPPORTED_EXTENSIONS.has(path.extname(startPath).toLowerCase()) ? [toPosix(path.relative(workspaceRoot, startPath))] : [], truncated: false };

  const files: string[] = [];
  async function visit(directory: string) {
    if (files.length > maxFiles) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length > maxFiles) break;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name)) await visit(absolutePath);
      else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(toPosix(path.relative(workspaceRoot, absolutePath)));
    }
  }
  await visit(startPath);
  files.sort((left, right) => left.localeCompare(right));
  return { files: files.slice(0, maxFiles), truncated: files.length > maxFiles };
}

function findDirectExport(symbols: SymbolDefinition[], importedName: string) {
  if (importedName === "default") return symbols.find((symbol) => symbol.defaultExport) || symbols.find((symbol) => symbol.exported && symbol.name === "default");
  return symbols.find((symbol) => symbol.exported && symbol.name === importedName);
}

/**
 * 构建工作区符号图，并将文件内引用和跨文件导入统一关联到定义 ID。
 */
export async function buildSymbolGraph(workspaceRoot: string, options: BuildSymbolGraphOptions = {}): Promise<SymbolGraph> {
  const root = path.resolve(workspaceRoot);
  const collected = await collectSourceFiles(root, options);
  const files = collected.files;
  const sourceStats = new Map<string, { mtimeMs: number; size: number }>();
  for (const filePath of files) {
    const stat = await fs.stat(path.join(root, filePath)).catch(() => null);
    if (stat) sourceStats.set(filePath, { mtimeMs: Number(stat.mtimeMs), size: Number(stat.size) });
  }
  const configPaths = [...new Set(files.map((filePath) => findCompilerConfig(root, filePath)).filter((value): value is string => Boolean(value)))];
  const configSignatures: string[] = [];
  for (const configPath of configPaths) {
    const stat = await fs.stat(configPath).catch(() => null);
    configSignatures.push(`${configPath}:${stat?.mtimeMs || 0}:${stat?.size || 0}`);
  }
  const signature = [collected.truncated, ...files.map((filePath) => {
    const stat = sourceStats.get(filePath);
    return `${filePath}:${stat?.mtimeMs || 0}:${stat?.size || 0}`;
  }), ...configSignatures.sort()].join("|");
  const cacheKey = `${root}:${options.path || ""}:${options.maxFiles || DEFAULT_MAX_FILES}`;
  const cachedGraph = graphCache.get(cacheKey);
  if (cachedGraph?.signature === signature) return cachedGraph.graph;
  const parsedFiles: ParsedSourceFile[] = [];

  for (const filePath of files) {
    const absolutePath = path.join(root, filePath);
    const stat = sourceStats.get(filePath);
    if (!stat) continue;
    const cached = parseCache.get(absolutePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      parsedFiles.push(structuredClone(cached.parsed));
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (content) {
      const parsed = parseSourceFile(content, filePath);
      parseCache.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed: structuredClone(parsed) });
      parsedFiles.push(parsed);
    }
  }

  const symbolsByFile = new Map(parsedFiles.map((file) => [file.filePath, file.symbols]));
  for (const file of parsedFiles) {
    for (const dependency of file.dependencies) dependency.toFile = await resolveWorkspaceModule(root, file.filePath, dependency.specifier);
  }

  const parsedByFile = new Map(parsedFiles.map((file) => [file.filePath, file]));
  const importedSymbolsByFile = new Map<string, Map<string, SymbolDefinition>>();
  function findExport(filePath: string, importedName: string, visited = new Set<string>()): SymbolDefinition | undefined {
    const visitKey = `${filePath}:${importedName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);
    const direct = findDirectExport(symbolsByFile.get(filePath) || [], importedName);
    if (direct) return direct;
    const file = parsedByFile.get(filePath);
    const localExport = file?.exports.find((item) => item.exportedName === importedName);
    if (localExport) {
      const local = (symbolsByFile.get(filePath) || []).find((symbol) => symbol.name === localExport.localName);
      if (local) return local;
    }
    const reExport = file?.imports.find((item) => item.reExport && (item.localName === importedName || item.importedName === "*"));
    const targetFile = reExport ? file?.dependencies.find((dependency) => dependency.specifier === reExport.moduleSpecifier)?.toFile : undefined;
    return reExport && targetFile ? findExport(targetFile, reExport.importedName === "*" ? importedName : reExport.importedName, visited) : undefined;
  }

  for (const file of parsedFiles) {
    const localSymbols = new Map<string, SymbolDefinition>();
    for (const symbol of file.symbols) if (!localSymbols.has(symbol.name)) localSymbols.set(symbol.name, symbol);
    const importedSymbols = new Map<string, SymbolDefinition>();
    importedSymbolsByFile.set(file.filePath, importedSymbols);

    for (const imported of file.imports) {
      const targetFile = file.dependencies.find((dependency) => dependency.specifier === imported.moduleSpecifier)?.toFile;
      const target = targetFile && !imported.namespaceImport ? findExport(targetFile, imported.importedName) : undefined;
      if (target) importedSymbols.set(imported.localName, target);
      file.references.push({
        name: imported.localName,
        kind: "import",
        targetSymbolId: target?.id,
        moduleSpecifier: imported.moduleSpecifier,
        filePath: file.filePath,
        line: imported.line,
        column: imported.column
      });
    }

    for (const reference of file.references) {
      // Vue 脚本当前不进入 TypeScript Program，保留名称级降级关联。
      if (file.filePath.endsWith(".vue") && !reference.targetSymbolId && reference.kind !== "import") reference.targetSymbolId = localSymbols.get(reference.name)?.id || importedSymbols.get(reference.name)?.id;
    }
  }

  bindSemanticReferences(root, parsedFiles);
  for (const file of parsedFiles) {
    const importedSymbols = importedSymbolsByFile.get(file.filePath);
    if (!importedSymbols) continue;
    // TypeScript 无法直接加载 Vue 虚拟模块时，使用已解析导入进行安全降级绑定。
    for (const reference of file.references) {
      if (!reference.targetSymbolId) reference.targetSymbolId = importedSymbols.get(reference.name)?.id;
    }
  }

  const symbols = parsedFiles.flatMap((file) => file.symbols);
  const references = parsedFiles.flatMap((file) => file.references);
  const graph: SymbolGraph = {
    workspaceRoot: root,
    files,
    symbols,
    references,
    dependencies: parsedFiles.flatMap((file) => file.dependencies),
    unresolvedReferenceCount: references.filter((reference) => !reference.targetSymbolId).length,
    indexTruncated: collected.truncated
  };
  graphCache.set(cacheKey, { signature, graph });
  return graph;
}
