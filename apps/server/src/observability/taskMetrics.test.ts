import assert from "node:assert/strict";
import test from "node:test";
import { RunMetricsTracker } from "./runMetrics.js";
import { clearTaskMetricsForTest, finalizeTaskMetrics, getTaskMetricsSnapshot, recordTaskPatchMetrics } from "./taskMetrics.js";

test("按任务聚合审批前后模型片段、补丁和验证指标", async () => {
  const taskSessionId = "task-metrics-test";
  await clearTaskMetricsForTest({ key: taskSessionId });

  const first = new RunMetricsTracker({ runId: "run-before-approval", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  first.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
  first.addUsage({ inputTokens: 10, outputTokens: 2, reasoningTokens: 1, cachedInputTokens: 0 });
  first.recordToolCall();
  first.recordContextEstimate(100, 80, true);
  await first.finish({ status: "awaiting_approval" });

  const resumed = new RunMetricsTracker({ runId: "run-after-approval", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  resumed.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
  resumed.addUsage({ inputTokens: 7, outputTokens: 3, reasoningTokens: 0, cachedInputTokens: 2 });
  resumed.recordToolCall({ failed: true });
  await resumed.finish({ status: "completed" });

  const validation = new RunMetricsTracker({ runId: "validation-run", taskSessionId, provider: "local", model: "none", mode: "validation", scope: "validation_run" }, async () => {});
  await validation.finish({ status: "completed", failureCategory: "validation_failure", validationCommandCount: 2, validationStatus: "passed" });
  await recordTaskPatchMetrics(taskSessionId, 2);

  const snapshot = await getTaskMetricsSnapshot(taskSessionId);
  assert.ok(snapshot);
  assert.equal(snapshot.scope, "task_run");
  assert.equal(snapshot.tools.calls, 2);
  assert.equal(snapshot.tools.failedCalls, 1);
  assert.deepEqual(snapshot.usage, { inputTokens: 17, outputTokens: 5, reasoningTokens: 1, cachedInputTokens: 2 });
  assert.equal(snapshot.estimatedCostUsd, 0.000074);
  assert.equal(snapshot.context.compressionCount, 1);
  assert.equal(snapshot.result.patchFileCount, 2);
  assert.equal(snapshot.result.validationCommandCount, 2);
  assert.equal(snapshot.result.validationStatus, "passed");

  let persisted = null;
  const finalized = await finalizeTaskMetrics(taskSessionId, "completed", async (metrics) => { persisted = metrics; });
  assert.equal(finalized?.result.failureCategory, "none");
  assert.deepEqual(persisted, finalized);
  assert.equal(await getTaskMetricsSnapshot(taskSessionId), null);
  await clearTaskMetricsForTest({ key: taskSessionId });
});

test("服务重启后从磁盘恢复审批前指标并继续聚合", async () => {
  const taskSessionId = "task-metrics-restart-test";
  await clearTaskMetricsForTest({ key: taskSessionId });
  const beforeRestart = new RunMetricsTracker({ runId: "before-restart", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  beforeRestart.addUsage({ inputTokens: 11, outputTokens: 2, reasoningTokens: 0, cachedInputTokens: 0 });
  beforeRestart.recordToolCall();
  await beforeRestart.finish({ status: "awaiting_approval" });

  // 只清空内存来模拟服务进程重启，磁盘快照必须继续可用。
  await clearTaskMetricsForTest({ memoryOnly: true });
  const afterRestart = new RunMetricsTracker({ runId: "after-restart", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  afterRestart.addUsage({ inputTokens: 5, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 1 });
  afterRestart.recordToolCall();
  await afterRestart.finish({ status: "completed" });
  await recordTaskPatchMetrics(taskSessionId, 1);

  const restored = await getTaskMetricsSnapshot(taskSessionId);
  assert.ok(restored);
  assert.equal(restored.tools.calls, 2);
  assert.equal(restored.usage.inputTokens, 16);
  assert.equal(restored.result.patchFileCount, 1);
  await finalizeTaskMetrics(taskSessionId, "completed", async () => {});
  await clearTaskMetricsForTest({ key: taskSessionId });
});
