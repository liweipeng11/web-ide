import { AgentRuntimeError } from "./errors.js";
import type { RuntimeFailureCategory } from "./contracts.js";

export type RetryClassification = {
  category: RuntimeFailureCategory;
  retryable: boolean;
};

function errorDetails(error: unknown) {
  return error && typeof error === "object"
    ? error as { name?: unknown; code?: unknown; status?: unknown; retryable?: unknown; category?: unknown; message?: unknown }
    : {};
}

/** 只依据稳定字段分类，避免依赖第三方异常类或把普通逻辑失败误判为瞬时故障。 */
export function classifyRuntimeError(error: unknown): RetryClassification {
  if (error instanceof AgentRuntimeError) {
    if (error.code === "AGENT_TIMEOUT") return { category: "timeout", retryable: true };
    if (error.code === "AGENT_CANCELLED") return { category: "cancelled", retryable: false };
    if (error.code === "AGENT_RETRY_EXHAUSTED") return { category: "model_error", retryable: false };
    if (error.code === "PERMISSION_DENIED" || error.code === "SCOPE_VIOLATION") {
      return { category: "permission_error", retryable: false };
    }
    if (error.code === "INVALID_CONTRACT" || error.code === "INVALID_STATE_TRANSITION") {
      return { category: "contract_error", retryable: false };
    }
    return { category: "internal_error", retryable: false };
  }

  const detail = errorDetails(error);
  if (detail.name === "AbortError" || detail.code === "ABORT_ERR" || detail.code === "cancelled") {
    return { category: "cancelled", retryable: false };
  }
  if (detail.code === "timeout" || detail.code === "ETIMEDOUT" || detail.code === "UND_ERR_CONNECT_TIMEOUT"
    || detail.status === 408 || detail.status === 504) {
    return { category: "timeout", retryable: true };
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("tool")) return { category: "tool_error", retryable: detail.retryable === true };
  if (detail.retryable === true) return { category: "model_error", retryable: true };
  if (detail.status === 429 || (typeof detail.status === "number" && detail.status >= 500)) {
    return { category: "model_error", retryable: true };
  }

  if (/\b(test|lint|typecheck|build|validation)\b/.test(message)) {
    return { category: "validation_failure", retryable: false };
  }
  if (/\b(network|fetch failed|socket|econnreset|eai_again|temporar)/.test(message)) {
    return { category: "model_error", retryable: true };
  }
  return { category: "internal_error", retryable: false };
}

export function shouldRetryRuntimeError(input: {
  error: unknown;
  attempt: number;
  maxAttempts: number;
  hasChangedFiles: boolean;
  externallyAborted: boolean;
}) {
  const classification = classifyRuntimeError(input.error);
  return {
    ...classification,
    shouldRetry: classification.retryable
      && input.attempt < input.maxAttempts
      && !input.hasChangedFiles
      && !input.externallyAborted
  };
}
