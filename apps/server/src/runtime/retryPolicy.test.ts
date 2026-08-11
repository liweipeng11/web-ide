import assert from "node:assert/strict";
import test from "node:test";
import { runtimeError } from "./errors.js";
import { classifyRuntimeError, shouldRetryRuntimeError } from "./retryPolicy.js";

test("重试策略只放行瞬时模型和网络错误", () => {
  assert.deepEqual(classifyRuntimeError({ status: 429 }), { category: "model_error", retryable: true });
  assert.deepEqual(classifyRuntimeError({ code: "ETIMEDOUT" }), { category: "timeout", retryable: true });
  assert.equal(classifyRuntimeError(new Error("typecheck validation failed")).retryable, false);
  assert.equal(classifyRuntimeError(runtimeError("PERMISSION_DENIED", "拒绝访问")).retryable, false);
});

test("已有写入或用户取消时禁止自动重试", () => {
  const transient = Object.assign(new Error("fetch failed"), { retryable: true });
  assert.equal(shouldRetryRuntimeError({ error: transient, attempt: 1, maxAttempts: 3, hasChangedFiles: true, externallyAborted: false }).shouldRetry, false);
  assert.equal(shouldRetryRuntimeError({ error: transient, attempt: 1, maxAttempts: 3, hasChangedFiles: false, externallyAborted: true }).shouldRetry, false);
});
