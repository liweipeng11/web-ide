import { AgentRuntimeError } from "../runtime/errors.js";

const RECOVERABLE_CODES = new Set(["ENOENT", "FILE_NOT_FOUND", "NO_MATCH"]);

function errorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return "UNKNOWN";
  return typeof error.code === "string" ? error.code : "UNKNOWN";
}

/** 权限、契约和循环限制必须立即失败；仅把局部查找类错误交还 Agent 换策略。 */
export function recoverableToolObservation(error: unknown) {
  if (error instanceof AgentRuntimeError) return null;
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : "工具执行失败。";
  if (!RECOVERABLE_CODES.has(code) && !/file not found|no match|找不到.*文件|文件不存在/i.test(message)) {
    return null;
  }
  return {
    status: "failed" as const,
    recoverable: true,
    error: code,
    message
  };
}
