import type { CommandExecution } from "./types.js";
import { stripAnsi } from "./commandOutputParser.js";

export type CommandOutputSummary = {
  summary: string;
  output: string;
  truncated: boolean;
};

function compactOutput(value: string) {
  const lines = stripAnsi(value).split("\n");
  const compacted: string[] = [];
  let previous = "";
  let repeats = 0;

  const flushRepeats = () => {
    if (repeats > 0) compacted.push(`[上一行重复 ${repeats} 次]`);
    repeats = 0;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === previous && line) {
      repeats += 1;
      continue;
    }
    flushRepeats();
    // 过滤只有百分比变化的动画帧，避免占满模型上下文。
    if (/^\s*(?:\d{1,3}%|[|/\\-])\s*$/.test(line)) continue;
    compacted.push(line);
    previous = line;
  }
  flushRepeats();
  return compacted.join("\n").trim();
}

/** 生成供模型使用的有界命令结果；磁盘中的 UI 日志不受此限制。 */
export function createCommandOutputSummary(execution: CommandExecution, fullOutput: string, maxLength = 4_000): CommandOutputSummary {
  const compacted = compactOutput(fullOutput);
  const truncated = compacted.length > maxLength;
  let output = truncated ? compacted.slice(-maxLength) : compacted;
  if (truncated && execution.state === "failed") {
    const lines = compacted.split("\n");
    let errorIndex = -1;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (/\b(?:error|failed|failure|exception|fatal)\b/i.test(lines[index])) {
        errorIndex = index;
        break;
      }
    }
    if (errorIndex >= 0) {
      const evidenceBudget = Math.min(1_200, Math.floor(maxLength * 0.45));
      const nearby = [lines[errorIndex], lines[errorIndex - 1], lines[errorIndex + 1]].filter((line): line is string => typeof line === "string");
      const evidence = nearby.map((line) => line.slice(0, 300)).join("\n").slice(0, evidenceBudget);
      const prefix = `[错误上下文]\n${evidence}\n[输出尾部]\n`;
      output = `${prefix}${compacted.slice(-Math.max(0, maxLength - prefix.length))}`;
    }
  }
  const stateLabel = execution.state === "running" && execution.readiness === "ready"
    ? `服务已就绪${execution.readyUrl ? `：${execution.readyUrl}` : ""}`
    : `命令状态：${execution.state}${execution.exitCode === null ? "" : `，退出码 ${execution.exitCode}`}`;
  return {
    summary: `${stateLabel}。${truncated ? "输出已压缩并截断，仅保留末尾。" : "输出未截断。"}`,
    output,
    truncated
  };
}
