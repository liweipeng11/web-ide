import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appStatePath } from "../statePaths.js";
import { StateFileError } from "../stateFileStorage.js";
import { RunMetricsTracker } from "./runMetrics.js";
import { clearTaskMetricsForTest, finalizeTaskMetrics, getTaskMetricsSnapshot, getTaskSessionPersistenceMetrics, recordTaskPatchMetrics, recordTaskSafeEditorMetrics, recordTaskSessionPersistenceMetrics } from "./taskMetrics.js";

test("按任务聚合审批前后模型片段、补丁和验证指标", async () => {
  const taskSessionId = "task-metrics-test";
  await clearTaskMetricsForTest({ key: taskSessionId });

  const first = new RunMetricsTracker({ runId: "run-before-approval", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  first.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
  first.addUsage({ inputTokens: 10, outputTokens: 2, reasoningTokens: 1, cachedInputTokens: 0 });
  first.recordToolCall();
  first.recordProviderCall();
  first.recordChangedFileCount(2);
  first.recordCompletionRequest();
  first.recordCompletionRejected({
    diagnostic: {
      rejectionCode: "PENDING_APPROVAL",
      evidenceFingerprint: "approval-fingerprint",
      changedFileCount: 2,
      persistedAppliedFileCount: 2,
      validationStatus: "not_run",
      lastMutationAt: 10,
      lastValidationAt: null
    }
  });
  first.recordContextEstimate(100, 80, true);
  await first.finish({ status: "awaiting_approval" });

  const resumed = new RunMetricsTracker({ runId: "run-after-approval", taskSessionId, provider: "mock", model: "mock-v1", mode: "act" }, async () => {});
  resumed.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
  resumed.addUsage({ inputTokens: 7, outputTokens: 3, reasoningTokens: 0, cachedInputTokens: 2 });
  resumed.recordToolCall({ failed: true });
  resumed.recordProviderCall();
  resumed.recordApprovalResume();
  resumed.recordChangedFileCount(2);
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
  assert.equal(snapshot.approvalResumeCount, 1);
  assert.equal(snapshot.providerCallCount, 2);
  assert.equal(snapshot.providerCallsAfterFirstCompletionRejection, 1);
  assert.equal(snapshot.changedFileCount, 2);
  assert.equal(snapshot.inputTokensPerChangedFile, 8.5);
  assert.equal(snapshot.contextCompressionCount, 1);
  assert.equal(snapshot.completionRejections[0]?.rejectionCode, "PENDING_APPROVAL");
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

test("审批前后累计资源消耗在任务级触发保护告警", async () => {
  const taskSessionId = "task-resource-alert-aggregation";
  await clearTaskMetricsForTest({ key: taskSessionId });
  try {
    for (const runId of ["resource-before", "resource-after"]) {
      const tracker = new RunMetricsTracker(
        { runId, taskSessionId, provider: "mock", model: "mock", mode: "act" },
        async () => {}
      );
      tracker.addUsage({ inputTokens: 60_000, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 });
      tracker.recordChangedFileCount(1);
      tracker.recordCompletionRejected();
      tracker.recordProviderCall();
      tracker.recordProviderCall();
      tracker.recordContextEstimate(80_000, 60_000, true);
      tracker.recordContextEstimate(80_000, 60_000, true);
      await tracker.finish({ status: "awaiting_approval" });
    }

    const snapshot = await getTaskMetricsSnapshot(taskSessionId);
    assert.ok(snapshot);
    assert.equal(snapshot.inputTokensPerChangedFile, 120_000);
    assert.equal(snapshot.providerCallsAfterFirstCompletionRejection, 4);
    assert.equal(snapshot.contextCompressionCount, 4);
    assert.deepEqual(snapshot.completionResourceAlerts.sort(), [
      "EXCESSIVE_CONTEXT_COMPRESSION",
      "EXCESSIVE_PROVIDER_CALLS_AFTER_REJECTION",
      "HIGH_INPUT_TOKENS_PER_CHANGED_FILE"
    ]);
  } finally {
    await clearTaskMetricsForTest({ key: taskSessionId });
  }
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

test("任务指标损坏时从备份恢复且没有备份时明确报错", async () => {
  const taskSessionId = "task-metrics-corrupt-recovery";
  await clearTaskMetricsForTest({ key: taskSessionId });
  const fileName = `${crypto.createHash("sha256").update(taskSessionId).digest("hex")}.json`;
  const filePath = path.join(appStatePath("task-metrics"), fileName);
  try {
    const tracker = new RunMetricsTracker({ runId: "metrics-before-corrupt", taskSessionId, provider: "mock", model: "mock", mode: "act" }, async () => {});
    tracker.addUsage({ inputTokens: 9, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 });
    await tracker.finish({ status: "awaiting_approval" });
    await recordTaskPatchMetrics(taskSessionId, 1); // 生成上一份有效 .bak 快照
    await clearTaskMetricsForTest({ memoryOnly: true });
    await fs.writeFile(filePath, "{broken", "utf8");

    const restored = await getTaskMetricsSnapshot(taskSessionId);
    assert.ok(restored);
    assert.equal(restored.usage.inputTokens, 9);
    assert.equal((await fs.readdir(path.dirname(filePath))).some((name) => name.startsWith(`${fileName}.corrupt-`)), true);

    await clearTaskMetricsForTest({ key: taskSessionId });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{still-broken", "utf8");
    await assert.rejects(
      () => getTaskMetricsSnapshot(taskSessionId),
      (error: unknown) => error instanceof StateFileError && error.code === "STATE_FILE_INVALID_JSON"
    );
  } finally {
    await clearTaskMetricsForTest({ key: taskSessionId });
  }
});

test("旧任务指标快照缺少阶段四字段时按零值兼容读取", async () => {
  const taskSessionId = "task-metrics-legacy-stage4";
  await clearTaskMetricsForTest({ key: taskSessionId });
  try {
    const tracker = new RunMetricsTracker(
      { runId: "legacy-source", taskSessionId, provider: "mock", model: "mock", mode: "act" },
      async () => {}
    );
    await tracker.finish({ status: "awaiting_approval" });

    const fileName = `${crypto.createHash("sha256").update(taskSessionId).digest("hex")}.json`;
    const filePath = path.join(appStatePath("task-metrics"), fileName);
    const legacy = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    for (const field of [
      "approvalResumeCount",
      "mutationEvidenceRestoreFailureCount",
      "providerCallCount",
      "providerCallsAfterFirstCompletionRejection",
      "changedFileCount",
      "inputTokensPerChangedFile",
      "contextCompressionCount",
      "completionResourceAlerts",
      "completionRejections"
    ]) delete legacy[field];
    await fs.writeFile(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

    await clearTaskMetricsForTest({ memoryOnly: true });
    const restored = await getTaskMetricsSnapshot(taskSessionId);
    assert.ok(restored);
    assert.equal(restored.approvalResumeCount, 0);
    assert.equal(restored.providerCallCount, 0);
    assert.equal(restored.inputTokensPerChangedFile, null);
    assert.deepEqual(restored.completionRejections, []);
  } finally {
    await clearTaskMetricsForTest({ key: taskSessionId });
  }
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
