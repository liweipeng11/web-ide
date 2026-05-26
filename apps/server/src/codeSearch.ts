import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { HttpError } from "./errors.js";
import type { CodeSearchResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

const execFileAsync = promisify(execFile);
const MAX_RESULTS = 200;

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

function parseRipgrepOutput(stdout: string): CodeSearchResult[] {
  const results: CodeSearchResult[] = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;

    const message = JSON.parse(line) as RipgrepJsonMessage;

    if (!isRipgrepMatch(message)) continue;

    const firstMatch = message.data.submatches[0];

    if (!firstMatch) continue;

    results.push({
      path: normalizeRelativePath(message.data.path.text),
      line: message.data.line_number,
      column: firstMatch.start + 1,
      text: message.data.lines.text.trimEnd(),
      match: firstMatch.match.text
    });

    if (results.length >= MAX_RESULTS) break;
  }

  return results;
}

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
      "rg",
      ["--json", "--line-number", "--column", "--color", "never", "--glob", "!node_modules", "--glob", "!.git", "-F", needle, "."],
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
      throw new HttpError(500, "ripgrep (rg) is not installed or not available in PATH");
    }

    throw error;
  }
}
