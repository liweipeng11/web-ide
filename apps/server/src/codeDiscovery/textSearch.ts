import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../errors.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { hasIgnoredSegment, safeResolve, toWorkspaceRelative } from "./pathPolicy.js";
import type { CodeSearchResult, TextSearchOptions } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RESULTS = 50;
const HARD_MAX_RESULTS = 200;
const MAX_CONTEXT_LINES = 5;
const IGNORED_GLOBS = ["!node_modules", "!dist", "!build", "!.git", "!.next", "!.mini-ai/state"];
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git", ".next"]);

type SearchMode = "literal" | "regex";

type NormalizedTextSearchOptions = {
  path: string;
  filePattern?: string;
  limit: number;
  caseSensitive: boolean;
  contextLines: number;
};

type RipgrepJsonMessage =
  | {
      type: "match";
      data: {
        path: { text: string };
        lines: { text: string };
        line_number: number;
        submatches: Array<{ match: { text: string }; start: number }>;
      };
    }
  | {
      type: "context";
      data: {
        path: { text: string };
        lines: { text: string };
        line_number: number;
      };
    }
  | { type: string; data?: unknown };

function isRipgrepMatch(message: RipgrepJsonMessage): message is Extract<RipgrepJsonMessage, { type: "match" }> {
  return message.type === "match";
}

function isRipgrepContext(message: RipgrepJsonMessage): message is Extract<RipgrepJsonMessage, { type: "context" }> {
  return message.type === "context";
}

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "limit must be a positive integer");
  }

  return Math.min(value, HARD_MAX_RESULTS);
}

function normalizeContextLines(value: number | undefined) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new HttpError(400, "contextLines must be a non-negative integer");
  }

  return Math.min(value, MAX_CONTEXT_LINES);
}

function normalizeTextSearchOptions(options: TextSearchOptions = {}): NormalizedTextSearchOptions {
  const searchPath = typeof options.path === "string" ? options.path.trim() : "";
  const filePattern = typeof options.filePattern === "string" ? options.filePattern.trim() : "";

  if (filePattern && (path.isAbsolute(filePattern) || filePattern.includes(".."))) {
    throw new HttpError(403, "filePattern must be a safe workspace-relative glob");
  }

  return {
    path: searchPath,
    filePattern: filePattern || undefined,
    limit: normalizeLimit(options.limit),
    caseSensitive: options.caseSensitive === true,
    contextLines: normalizeContextLines(options.contextLines)
  };
}

function normalizeRelativePath(value: string) {
  const withoutDot = value.replace(/^\.[\\/]/, "");
  return withoutDot.split(path.sep).join("/");
}

function matchesSimpleGlob(relativePath: string, pattern: string) {
  const normalizedPath = normalizeRelativePath(relativePath);
  const normalizedPattern = pattern.split(path.sep).join("/");
  const target = normalizedPattern.includes("/") ? normalizedPath : path.posix.basename(normalizedPath);

  if (!normalizedPattern.includes("*")) {
    return normalizedPath === normalizedPattern || normalizedPath.endsWith(`/${normalizedPattern}`);
  }

  let source = "";

  // 轻量 glob 只服务 Node fallback，覆盖 Agent 常用的文件后缀和目录模式即可。
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    const nextChar = normalizedPattern[index + 1];

    if (char === "*" && nextChar === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${source}$`).test(target);
}

// 解析 ripgrep JSON 输出，并保持旧搜索接口字段结构完全兼容。
function parseRipgrepOutput(stdout: string, limit: number, contextLines: number): CodeSearchResult[] {
  const results: CodeSearchResult[] = [];
  const pendingContext = new Map<string, Array<{ line: number; content: string }>>();
  let lastMatch: CodeSearchResult | null = null;
  let reachedLimit = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const message = JSON.parse(line) as RipgrepJsonMessage;

    if (isRipgrepContext(message)) {
      const filePath = normalizeRelativePath(message.data.path.text);
      const contextLine = {
        line: message.data.line_number,
        content: message.data.lines.text.trimEnd()
      };

      if (lastMatch?.filePath === filePath && message.data.line_number > lastMatch.line && message.data.line_number <= lastMatch.line + contextLines) {
        lastMatch.contextAfter = [...(lastMatch.contextAfter || []), contextLine].slice(0, contextLines);
        continue;
      }

      const current = pendingContext.get(filePath) || [];
      pendingContext.set(filePath, [...current, contextLine].slice(-contextLines));
      continue;
    }

    if (!isRipgrepMatch(message) || reachedLimit) continue;

    const firstMatch = message.data.submatches[0];

    if (!firstMatch) continue;
    const filePath = normalizeRelativePath(message.data.path.text);
    const contextBefore = contextLines > 0 ? pendingContext.get(filePath) || [] : [];

    const result: CodeSearchResult = {
      filePath,
      path: filePath,
      line: message.data.line_number,
      column: firstMatch.start + 1,
      content: message.data.lines.text.trimEnd(),
      text: message.data.lines.text.trimEnd(),
      match: firstMatch.match.text,
      ...(contextBefore.length ? { contextBefore } : {})
    };

    results.push(result);
    lastMatch = result;
    pendingContext.set(filePath, []);

    if (results.length >= limit) {
      reachedLimit = true;
      if (contextLines === 0) break;
    }
  }

  return results;
}

async function getRipgrepCommand() {
  try {
    const ripgrep = await import("@vscode/ripgrep");
    return ripgrep.rgPath;
  } catch {
    return "rg";
  }
}

function buildRipgrepArgs(pattern: string, mode: SearchMode, options: NormalizedTextSearchOptions) {
  const args = ["--json", "--line-number", "--column", "--color", "never", "--max-count", String(options.limit)];

  for (const ignoredGlob of IGNORED_GLOBS) {
    args.push("--glob", ignoredGlob);
  }

  if (options.filePattern) {
    args.push("--glob", options.filePattern);
  }

  if (!options.caseSensitive) {
    args.push("--ignore-case");
  }

  if (options.contextLines > 0) {
    args.push("--context", String(options.contextLines));
  }

  if (mode === "literal") {
    args.push("-F");
  }

  args.push(pattern, options.path || ".");
  return args;
}

async function walkSearchFiles(workspaceRoot: string, searchRoot: string, options: NormalizedTextSearchOptions, visitFile: (absolutePath: string, relativePath: string) => Promise<boolean>) {
  async function walk(directory: string): Promise<boolean> {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = toWorkspaceRelative(absolutePath);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || hasIgnoredSegment(relativePath)) continue;
        if (await walk(absolutePath)) return true;
        continue;
      }

      if (!entry.isFile()) continue;
      if (hasIgnoredSegment(relativePath)) continue;
      if (options.filePattern && !matchesSimpleGlob(relativePath, options.filePattern)) continue;
      if (await visitFile(absolutePath, normalizeRelativePath(path.relative(workspaceRoot, absolutePath)))) return true;
    }

    return false;
  }

  const stat = await fs.stat(searchRoot);

  if (stat.isFile()) {
    const relativePath = toWorkspaceRelative(searchRoot);
    if (!options.filePattern || matchesSimpleGlob(relativePath, options.filePattern)) {
      await visitFile(searchRoot, normalizeRelativePath(path.relative(workspaceRoot, searchRoot)));
    }
    return;
  }

  await walk(searchRoot);
}

// 当 ripgrep 不可用时使用 Node fallback，保证开发环境仍能完成基础 literal/regex 搜索。
async function searchTextWithNode(workspaceRoot: string, pattern: string, mode: SearchMode, options: NormalizedTextSearchOptions): Promise<CodeSearchResult[]> {
  const results: CodeSearchResult[] = [];
  const searchRoot = safeResolve(options.path);
  const regex = mode === "regex" ? new RegExp(pattern, options.caseSensitive ? "g" : "gi") : null;
  const literalNeedle = options.caseSensitive ? pattern : pattern.toLowerCase();

  await walkSearchFiles(workspaceRoot, searchRoot, options, async (absolutePath, relativePath) => {
    let content = "";

    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      return false;
    }

    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match =
        mode === "regex"
          ? (() => {
              regex!.lastIndex = 0;
              return regex!.exec(line);
            })()
          : null;
      const column = mode === "regex" ? (match ? match.index : -1) : (options.caseSensitive ? line : line.toLowerCase()).indexOf(literalNeedle);

      if (column === -1) continue;

      results.push({
        filePath: relativePath,
        path: relativePath,
        line: index + 1,
        column: column + 1,
        content: line,
        text: line,
        match: mode === "regex" ? match![0] : pattern,
        ...(options.contextLines > 0
          ? {
              // Node fallback 没有 ripgrep 的 context 消息，这里按行号直接生成同等结构。
              contextBefore: lines
                .slice(Math.max(0, index - options.contextLines), index)
                .map((content, offset) => ({
                  line: Math.max(0, index - options.contextLines) + offset + 1,
                  content
                })),
              contextAfter: lines.slice(index + 1, index + 1 + options.contextLines).map((content, offset) => ({
                line: index + offset + 2,
                content
              }))
            }
          : {})
      });

      if (results.length >= options.limit) return true;
    }

    return false;
  });

  return results;
}

async function searchText(pattern: string, mode: SearchMode, options: TextSearchOptions = {}) {
  const workspaceRoot = getWorkspaceRoot();
  const normalizedPattern = pattern.trim();
  const normalizedOptions = normalizeTextSearchOptions(options);

  if (!workspaceRoot) {
    throw new HttpError(400, "No workspace selected");
  }

  if (!normalizedPattern) {
    return [];
  }

  safeResolve(normalizedOptions.path);

  try {
    const { stdout } = await execFileAsync(await getRipgrepCommand(), buildRipgrepArgs(normalizedPattern, mode, normalizedOptions), {
      cwd: workspaceRoot,
      maxBuffer: 1024 * 1024 * 8,
      timeout: 15000
    });

    return parseRipgrepOutput(stdout, normalizedOptions.limit, normalizedOptions.contextLines);
  } catch (error) {
    const execError = error as { code?: number | string; stdout?: string; stderr?: string };

    if (execError.code === 1) {
      return execError.stdout ? parseRipgrepOutput(execError.stdout, normalizedOptions.limit, normalizedOptions.contextLines) : [];
    }

    if (execError.code === "ENOENT") {
      return searchTextWithNode(workspaceRoot, normalizedPattern, mode, normalizedOptions);
    }

    if (mode === "regex" && typeof execError.stderr === "string" && execError.stderr.trim()) {
      throw new HttpError(400, execError.stderr.trim().split(/\r?\n/).at(0) || "Invalid regex");
    }

    throw error;
  }
}

export function searchTextLiteral(query: string, options: TextSearchOptions = {}): Promise<CodeSearchResult[]> {
  return searchText(query, "literal", options);
}

export function searchTextRegex(regex: string, options: TextSearchOptions = {}): Promise<CodeSearchResult[]> {
  try {
    new RegExp(regex);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Invalid regex");
  }

  return searchText(regex, "regex", options);
}

// 工作区文本搜索旧入口，默认保持字面量搜索语义。
export async function searchWorkspaceCode(query: string, options: TextSearchOptions = {}): Promise<CodeSearchResult[]> {
  return searchTextLiteral(query, options);
}
