import assert from "node:assert/strict";
import test from "node:test";
import { RunMetricsTracker } from "./runMetrics.js";
import { clearTaskMetricsForTest, finalizeTaskMetrics, getTaskMetricsSnapshot, getTaskSessionPersistenceMetrics, recordTaskPatchMetrics, recordTaskSafeEditorMetrics, recordTaskSessionPersistenceMetrics } from "./taskMetrics.js";

test("按任务聚合审批前后模型片段、补丁和验证指标", async () => {
  const taskSessionId = "task-metrics-test";
  await clearTaskMetricsForTest({ key: taskSessionId });

  const first = new RunMetricsTracker({ runId: "run-before-approval", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  first.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
  first.addUsage({ inputTokens: 10, outputTokens: 2, reasoningTokens: 1, cachedInputTokens: 0 });
  first.recordToolCall();
  first.recordCompletionRequest();
  first.recordCompletionRejected();
  first.recordContextEstimate(100, 80, true);
  await first.finish({ status: "awaiting_approval" });

  const resumed = new RunMetricsTracker({ runId: "run-after-approval", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  resumed.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
  resumed.addUsage({ inputTokens: 7, outputTokens: 3, reasoningTokens: 0, cachedInputTokens: 2 });
  resumed.recordToolCall({ failed: true });
  resumed.recordCompletionRequest();
  resumed.recordCompletionAccepted();
  await resumed.finish({ status: "completed" });

  const validation = new RunMetricsTracker({ runId: "validation-run", taskSessionId, provider: "local", model: "none", mode: "validation", scope: "validation_run" }, async () => {});
  await validation.finish({ status: "completed", failureCategory: "validation_failure", validationCommandCount: 2, validationStatus: "passed" });
  await recordTaskPatchMetrics(taskSessionId, 2);

  const snapshot = await getTaskMetricsSnapshot(taskSessionId);
  assert.ok(snapshot);
  assert.equal(snapshot.scope, "task_run");
  assert.equal(snapshot.tools.calls, 2);
  assert.equal(snapshot.tools.failedCalls, 1);
  assert.equal(snapshot.completionRequestCount, 2);
  assert.equal(snapshot.completionAcceptedCount, 1);
  assert.equal(snapshot.completionRejectedCount, 1);
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

test("按任务聚合六项 Safe Editor 灰度指标", async () => {
  const taskSessionId = "task-safe-editor-metrics-test";
  await clearTaskMetricsForTest({ key: taskSessionId });

  const tracker = new RunMetricsTracker(
    { runId: "safe-editor-run", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" },
    async () => {}
  );
  tracker.recordSafeEditorMetrics({
    safeEditorNeedsAnalysisCount: 1,
    safeEditorAutoAnalysisAttemptCount: 1,
    safeEditorAutoAnalysisSuccessCount: 1,
    safeEditorConfirmedExpansionCount: 2,
    safeEditorFalseExpansionRegressionCount: 2
  });
  await tracker.finish({ status: "awaiting_approval" });

  // 用户审批发生在模型运行结束后，必须继续合并到同一份任务指标。
  await recordTaskSafeEditorMetrics(taskSessionId, { safeEditorRiskAcknowledgementCount: 1 });
  const snapshot = await getTaskMetricsSnapshot(taskSessionId);

  assert.ok(snapshot);
  assert.equal(snapshot.safeEditorNeedsAnalysisCount, 1);
  assert.equal(snapshot.safeEditorAutoAnalysisAttemptCount, 1);
  assert.equal(snapshot.safeEditorAutoAnalysisSuccessCount, 1);
  assert.equal(snapshot.safeEditorConfirmedExpansionCount, 2);
  assert.equal(snapshot.safeEditorRiskAcknowledgementCount, 1);
  assert.equal(snapshot.safeEditorFalseExpansionRegressionCount, 2);

  await finalizeTaskMetrics(taskSessionId, "completed", async () => {});
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

test("聚合任务会话逻辑更新、物理写入、跳过、合并和 rename 重试指标", async () => {
  const taskSessionId = "task-session-persistence-metrics-test";
  await clearTaskMetricsForTest({ key: taskSessionId });
  try {
    // 存储指标可能早于首个模型片段产生，必须在任务指标创建后完整并入。
    recordTaskSessionPersistenceMetrics(taskSessionId, {
      taskSessionUpdateCount: 100,
      taskSessionPhysicalWriteCount: 2,
      taskSessionWriteSkippedCount: 3,
      taskSessionWriteCoalescedCount: 98,
      taskSessionRenameRetryCount: 2
    });
    const tracker = new RunMetricsTracker(
      { runId: "persistence-run", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" },
      async () => {}
    );
    await tracker.finish({ status: "awaiting_approval" });

    recordTaskSessionPersistenceMetrics(taskSessionId, { taskSessionUpdateCount: 1, taskSessionPhysicalWriteCount: 1 });
    assert.deepEqual(await getTaskSessionPersistenceMetrics(taskSessionId), {
      taskSessionUpdateCount: 101,
      taskSessionPhysicalWriteCount: 3,
      taskSessionWriteSkippedCount: 3,
      taskSessionWriteCoalescedCount: 98,
      taskSessionRenameRetryCount: 2
    });
    assert.deepEqual((await getTaskMetricsSnapshot(taskSessionId))?.taskSessionPersistence, {
      taskSessionUpdateCount: 101,
      taskSessionPhysicalWriteCount: 3,
      taskSessionWriteSkippedCount: 3,
      taskSessionWriteCoalescedCount: 98,
      taskSessionRenameRetryCount: 2
    });
  } finally {
    await clearTaskMetricsForTest({ key: taskSessionId });
  }
});
