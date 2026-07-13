import type { CommandResult } from "../types.js";
import type { VerificationIssue, VerificationIssueCategory, VerificationStage } from "./types.js";

const maxIssues = 50;

function categoryFor(stage: VerificationStage, message: string, result: CommandResult): VerificationIssueCategory {
  if (result.status === "timeout") return "timeout";
  if (/syntaxerror|parse error|unexpected token/i.test(message)) return "syntax";
  if (/\bTS\d{4}\b|type error|typeerror/i.test(message)) return "type";
  if (stage === "format_syntax") return "syntax";
  if (stage === "typecheck") return "type";
  if (stage === "lint") return "lint";
  if (stage === "test") return "test";
  if (stage === "build") return "build";
  return "unknown";
}

function cleanFilePath(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/^file:\/\//, "");
}

/** 从常见 TypeScript、ESLint、测试框架输出中提取可供 Agent 定位的结构化问题。 */
export function parseVerificationFailure(result: CommandResult, stage: VerificationStage): VerificationIssue[] {
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n");
  const issues: VerificationIssue[] = [];
  const seen = new Set<string>();
  let eslintFile: string | undefined;

  const pushIssue = (issue: VerificationIssue) => {
    const key = `${issue.file || ""}:${issue.line || 0}:${issue.column || 0}:${issue.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(issue);
  };

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const typescript = line.match(/^(.*?\.[cm]?[jt]sx?)\((\d+),(\d+)\):\s*(?:error\s*)?(TS\d+)?\s*:?\s*(.+)$/);
    if (typescript) {
      pushIssue({
        category: categoryFor(stage, typescript[5], result),
        file: cleanFilePath(typescript[1]),
        line: Number(typescript[2]),
        column: Number(typescript[3]),
        code: typescript[4],
        message: typescript[5].trim()
      });
      continue;
    }

    const pythonTraceback = line.match(/^File\s+"(.+?\.py)",\s+line\s+(\d+)(?:,.*)?$/i);
    if (pythonTraceback) {
      pushIssue({ category: categoryFor(stage, line, result), file: cleanFilePath(pythonTraceback[1]), line: Number(pythonTraceback[2]), message: line });
      continue;
    }

    const eslintHeader = line.match(/^((?:[a-z]:[\\/]|\.?\.?[\\/]|\/|[a-z0-9_.-]+[\\/]).+\.(?:[cm]?[jt]sx?|vue))$/i);
    if (eslintHeader) {
      eslintFile = cleanFilePath(eslintHeader[1]);
      continue;
    }

    const eslintDetail = eslintFile ? line.match(/^(\d+):(\d+)\s+(?:error|warning)\s+(.+)$/i) : null;
    if (eslintDetail) {
      const details = eslintDetail[3].split(/\s{2,}/).filter(Boolean);
      const code = details.length > 1 ? details.pop() : undefined;
      const message = details.join("  ").trim();
      pushIssue({ category: "lint", file: eslintFile, line: Number(eslintDetail[1]), column: Number(eslintDetail[2]), code, message });
      continue;
    }

    // 兼容 Vitest/Jest 堆栈、Vite 前缀以及常见 file:line:column 单行输出。
    const located = line.match(/(?:^|[\s(>])((?:[a-z]:)?[^()\s]+?\.(?:[cm]?[jt]sx?|vue|py|css|json)):(\d+):(\d+)(?:\)?(?:\s*[-:]?\s*(.*))?)$/i);
    if (located) {
      const message = located[4]?.trim() || line;
      pushIssue({
        category: categoryFor(stage, message, result),
        file: cleanFilePath(located[1]),
        line: Number(located[2]),
        column: Number(located[3]),
        message
      });
      continue;
    }

    const pythonLocation = line.match(/^(.+?\.py):(\d+):\s*(.+)$/);
    if (pythonLocation) {
      pushIssue({ category: categoryFor(stage, pythonLocation[3], result), file: cleanFilePath(pythonLocation[1]), line: Number(pythonLocation[2]), message: pythonLocation[3].trim() });
    }

    if (issues.length >= maxIssues) break;
  }

  if (!issues.length) {
    const fallback = output.trim() || result.summary?.trim() || `命令退出码为 ${result.exitCode ?? "未知"}`;
    issues.push({
      category: result.status === "timeout" ? "timeout" : result.exitCode === null ? "command" : categoryFor(stage, fallback, result),
      message: fallback.slice(-2_000)
    });
  }

  return issues;
}
