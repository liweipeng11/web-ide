import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "../errors.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import type { CodeSearchResult } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 50;
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git"]);

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
  | { type: string; data?: unknown };

function isRipgrepMatch(message: RipgrepJsonMessage): message is Extract<RipgrepJsonMessage, { type: "match" }> {
  return message.type === "match";
}

function normalizeRelativePath(value: string) {
  const withoutDot = value.replace(/^\.[\\/]/, "");
  return withoutDot.split(path.sep).join("/");
}

// 解析 ripgrep JSON 输出，并保持旧搜索接口字段结构完全兼容。
function parseRipgrepOutput(stdout: string): CodeSearchResult[] {
  const results: CodeSearchResult[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const message = JSON.parse(line) as RipgrepJsonMessage;

    if (!isRipgrepMatch(message)) continue;

    const firstMatch = message.data.submatches[0];

    if (!firstMatch) continue;

    results.push({
      filePath: normalizeRelativePath(message.data.path.text),
      path: normalizeRelativePath(message.data.path.text),
      line: message.data.line_number,
      column: firstMatch.start + 1,
      content: message.data.lines.text.trimEnd(),
      text: message.data.lines.text.trimEnd(),
      match: firstMatch.match.text
    });

    if (results.length >= MAX_RESULTS) break;
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

// 当 ripgrep 不可用时使用 Node fallback，保证开发环境仍能完成基础搜索。
async function searchWorkspaceCodeWithNode(workspaceRoot: string, needle: string): Promise<CodeSearchResult[]> {
  const results: CodeSearchResult[] = [];

  async function walk(directory: string) {
    if (results.length >= MAX_RESULTS) return;

    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(directory, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;

      const absolutePath = path.join(directory, entry.name);
      let content = "";

      try {
        content = await fs.readFile(absolutePath, "utf8");
      } catch {
        continue;
      }

      const relativePath = normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const column = lines[index].indexOf(needle);

        if (column === -1) continue;

        results.push({
          filePath: relativePath,
          path: relativePath,
          line: index + 1,
          column: column + 1,
          content: lines[index],
          text: lines[index],
          match: needle
        });

        if (results.length >= MAX_RESULTS) return;
      }
    }
  }

  await walk(workspaceRoot);
  return results;
}

// 工作区文本搜索入口，第一阶段保留字面量搜索语义，后续阶段再扩展 regex 和范围选项。
export async function searchWorkspaceCode(query: string): Promise<CodeSearchResult[]> {
  const workspaceRoot = getWorkspaceRoot();
  const needle = query.trim();

  if (!workspaceRoot) {
    throw new HttpError(400, "No workspace selected");
  }

  if (!needle) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      await getRipgrepCommand(),
      ["--json", "--line-number", "--column", "--color", "never", "--glob", "!node_modules", "--glob", "!dist", "--glob", "!build", "--glob", "!.git", "-F", needle, "."],
      {
        cwd: workspaceRoot,
        maxBuffer: 1024 * 1024 * 8,
        timeout: 15000
      }
    );

    return parseRipgrepOutput(stdout);
  } catch (error) {
    const execError = error as { code?: number | string; stdout?: string };

    if (execError.code === 1) {
      return execError.stdout ? parseRipgrepOutput(execError.stdout) : [];
    }

    if (execError.code === "ENOENT") {
      return searchWorkspaceCodeWithNode(workspaceRoot, needle);
    }

    throw error;
  }
}
