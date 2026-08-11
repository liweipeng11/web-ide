import { runtimeError } from "./errors.js";

export type RuntimeExecutionPolicy = {
  timeoutMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
};

export const DEFAULT_RUNTIME_EXECUTION_POLICY: RuntimeExecutionPolicy = {
  timeoutMs: 60_000,
  maxAttempts: 3,
  retryBaseDelayMs: 400,
  retryMaxDelayMs: 2_000
};

export function validateRuntimeExecutionPolicy(policy: RuntimeExecutionPolicy) {
  if (!Number.isInteger(policy.timeoutMs) || policy.timeoutMs < 1) {
    throw runtimeError("INVALID_CONTRACT", "Agent timeoutMs 必须是正整数。", { timeoutMs: policy.timeoutMs });
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw runtimeError("INVALID_CONTRACT", "Agent maxAttempts 必须是正整数。", { maxAttempts: policy.maxAttempts });
  }
  if (!Number.isInteger(policy.retryBaseDelayMs) || policy.retryBaseDelayMs < 0
    || !Number.isInteger(policy.retryMaxDelayMs) || policy.retryMaxDelayMs < policy.retryBaseDelayMs) {
    throw runtimeError("INVALID_CONTRACT", "Agent 重试退避配置无效。", {
      retryBaseDelayMs: policy.retryBaseDelayMs,
      retryMaxDelayMs: policy.retryMaxDelayMs
    });
  }
}

/** 退避等待响应取消，避免用户中止后仍等待下一次重试。 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(runtimeError("AGENT_CANCELLED", "Agent 执行已取消。"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(runtimeError("AGENT_CANCELLED", "Agent 执行已取消。"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function retryDelayMs(policy: RuntimeExecutionPolicy, attempt: number) {
  return Math.min(policy.retryMaxDelayMs, policy.retryBaseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

/** 超时会主动 abort 底层操作，同时保证不响应信号的实现也能及时返回。 */
export async function runControlled<T>(input: {
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<T> {
  if (input.signal?.aborted) throw runtimeError("AGENT_CANCELLED", "Agent 执行已取消。");

  const controller = new AbortController();
  let settled = false;
  let rejectControl: ((error: unknown) => void) | null = null;
  const controlled = new Promise<never>((_, reject) => { rejectControl = reject; });
  const onExternalAbort = () => {
    if (settled) return;
    const error = runtimeError("AGENT_CANCELLED", "Agent 执行已取消。");
    rejectControl?.(error);
    controller.abort(error);
  };
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    if (settled) return;
    const error = runtimeError("AGENT_TIMEOUT", `Agent 执行超过 ${input.timeoutMs}ms。`, { timeoutMs: input.timeoutMs });
    rejectControl?.(error);
    controller.abort(error);
  }, input.timeoutMs);

  try {
    return await Promise.race([input.operation(controller.signal), controlled]);
  } finally {
    settled = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}
