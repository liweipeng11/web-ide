export type RuntimeErrorCode =
  | "INVALID_CONTRACT"
  | "INVALID_STATE_TRANSITION"
  | "TASK_NOT_FOUND"
  | "TASK_DEPENDENCY_NOT_SATISFIED"
  | "DUPLICATE_AGENT"
  | "UNKNOWN_AGENT"
  | "CAPABILITY_MISMATCH"
  | "DUPLICATE_TOOL"
  | "UNKNOWN_TOOL"
  | "PERMISSION_DENIED"
  | "SCOPE_VIOLATION";

/** 对外暴露稳定错误码，避免上层依赖第三方库或内部异常文本。 */
export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

export function runtimeError(code: RuntimeErrorCode, message: string, details: Record<string, unknown> = {}) {
  return new AgentRuntimeError(code, message, details);
}
