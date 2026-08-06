import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRunMetrics, classifyRunFailure, createEmptyProgressiveDeliveryMetrics, RunMetricsTracker } from "./runMetrics.js";
import { runAgentRuntime } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { RunMetrics } from "./runMetrics.js";

test("运行指标包含完整基线字段且日志不接收敏感正文", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-metrics-"));
  const filePath = path.join(directory, "metrics.jsonl");
  try {
    const tracker = new RunMetricsTracker({ runId: "run-1", taskSessionId: "task-1", provider: "mock", model: "mock-model", mode: "act" }, (metrics) => appendRunMetrics(metrics, filePath), false);
    tracker.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8, cachedInputPerMillionTokens: 1 });
    tracker.addUsage({ inputTokens: 10, outputTokens: 2, reasoningTokens: 1, cachedInputTokens: 4 });
    tracker.recordFirstTokenLatency(25, "provider");
    const signature = 'searchCode:{"query":"router"}';
    tracker.recordToolCall({ toolName: "searchCode", signature, step: 1 });
    tracker.recordToolResult({ signature, empty: true });
    tracker.recordToolCall({ toolName: "searchCode", signature, step: 2, repeated: true });
    tracker.recordToolResult({ signature, cached: true, empty: true });
    tracker.recordToolFailure();
    assert.deepEqual(tracker.getCompletionEvidenceSnapshot(), { failedToolCallCount: 1 });
    tracker.recordProviderCall();
    tracker.recordApprovalResume();
    tracker.recordMutationEvidenceRestoreFailure();
    tracker.recordChangedFileCount(2);
    tracker.recordCompletionRequest();
    tracker.recordCompletionRejected({
      diagnostic: {
        rejectionCode: "NO_MUTATION_EVIDENCE",
        evidenceFingerprint: "[0,0,\"passed\"]",
        changedFileCount: 0,
        persistedAppliedFileCount: 1,
        validationStatus: "passed",
        lastMutationAt: 10,
        lastValidationAt: 20
      }
    });
    tracker.recordProviderCall();
    tracker.recordCompletionRequest();
    tracker.recordCompletionRejected({ sameEvidence: true, loopStopped: true });
    tracker.recordCompletionRequest();
    tracker.recordCompletionAccepted();
    tracker.recordSafeEditorMetrics({
      safeEditorNeedsAnalysisCount: 1,
      safeEditorAutoAnalysisAttemptCount: 1,
      safeEditorAutoAnalysisSuccessCount: 1,
      safeEditorConfirmedExpansionCount: 1,
      safeEditorRiskAcknowledgementCount: 1,
      safeEditorFalseExpansionRegressionCount: 2
    });
    const metrics = await tracker.finish({ status: "completed", patchFileCount: 2, validationCommandCount: 1, validationStatus: "passed" });
    const log = await fs.readFile(filePath, "utf8");

    assert.deepEqual(metrics.tools, {
      calls: 2,
      repeatedCalls: 1,
      cacheHits: 1,
      emptyResults: 2,
      invalidToolCalls: 0,
      consecutiveNoProgressSteps: 2,
      maxConsecutiveNoProgressSteps: 2,
      recoveryAttempts: 0,
      failedCalls: 1,
      mostRepeatedCall: {
        toolName: "searchCode",
        signature,
        calls: 2,
        repeatedCalls: 1,
        firstStep: 1,
        lastStep: 2,
        allResultsEmpty: true,
        cacheHit: true
      }
    });
    assert.equal(metrics.usage.cachedInputTokens, 4);
    assert.equal(metrics.estimatedCostUsd, 0.000032);
    assert.equal(metrics.result.patchFileCount, 2);
    assert.equal(metrics.result.stopReason, "completed");
    assert.equal(metrics.firstTokenLatencyMs, 25);
    assert.equal(metrics.firstTokenLatencySource, "provider");
    assert.equal(metrics.safeEditorNeedsAnalysisCount, 1);
    assert.equal(metrics.safeEditorAutoAnalysisAttemptCount, 1);
    assert.equal(metrics.safeEditorAutoAnalysisSuccessCount, 1);
    assert.equal(metrics.safeEditorConfirmedExpansionCount, 1);
    assert.equal(metrics.safeEditorRiskAcknowledgementCount, 1);
    assert.equal(metrics.safeEditorFalseExpansionRegressionCount, 2);
    assert.equal(metrics.completionRequestCount, 3);
    assert.equal(metrics.completionAcceptedCount, 1);
    assert.equal(metrics.completionRejectedCount, 2);
    assert.equal(metrics.sameEvidenceRejectionCount, 1);
    assert.equal(metrics.approvalResumeCount, 1);
    assert.equal(metrics.mutationEvidenceRestoreFailureCount, 1);
    assert.equal(metrics.completionLoopStoppedCount, 1);
    assert.equal(metrics.providerCallCount, 2);
    assert.equal(metrics.providerCallsAfterFirstCompletionRejection, 1);
    assert.equal(metrics.changedFileCount, 2);
    assert.equal(metrics.inputTokensPerChangedFile, 5);
    assert.equal(metrics.completionRejections[0]?.rejectionCode, "NO_MUTATION_EVIDENCE");
    assert.equal(log.includes("Authorization"), false);
    assert.equal(log.includes("API_KEY"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("资源保护指标识别高 Token、过度压缩和拒绝后 Provider 调用", async () => {
  const tracker = new RunMetricsTracker(
    { runId: "resource-guard", taskSessionId: "task-resource", provider: "mock", model: "mock", mode: "act" },
    async () => undefined,
    false
  );
  tracker.addUsage({ inputTokens: 100_001, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 });
  tracker.recordChangedFileCount(1);
  for (let index = 0; index < 4; index += 1) tracker.recordContextEstimate(120_000, 80_000, true);
  tracker.recordCompletionRejected();
  for (let index = 0; index < 4; index += 1) tracker.recordProviderCall();

  const metrics = await tracker.finish({ status: "incomplete" });
  assert.equal(metrics.inputTokensPerChangedFile, 100_001);
  assert.equal(metrics.contextCompressionCount, 4);
  assert.equal(metrics.providerCallsAfterFirstCompletionRejection, 4);
  assert.deepEqual(metrics.completionResourceAlerts.sort(), [
    "EXCESSIVE_CONTEXT_COMPRESSION",
    "EXCESSIVE_PROVIDER_CALLS_AFTER_REJECTION",
    "HIGH_INPUT_TOKENS_PER_CHANGED_FILE"
  ]);
});

test("结构化完成拒绝诊断有界且不包含业务正文", async () => {
  const tracker = new RunMetricsTracker(
    { runId: "bounded-rejections", taskSessionId: "task-bounded", provider: "mock", model: "mock", mode: "act" },
    async () => undefined,
    false
  );
  for (let index = 0; index < 25; index += 1) {
    tracker.recordCompletionRejected({
      diagnostic: {
        rejectionCode: "VALIDATION_FAILED",
        evidenceFingerprint: `[1,0,\"failed\",${index}]`,
        changedFileCount: 1,
        persistedAppliedFileCount: 1,
        validationStatus: "failed",
        lastMutationAt: index,
        lastValidationAt: index
      }
    });
  }

  const metrics = await tracker.finish({ status: "incomplete" });
  const serialized = JSON.stringify(metrics.completionRejections);
  assert.equal(metrics.completionRejections.length, 20);
  assert.equal(serialized.includes("Authorization"), false);
  assert.equal(serialized.includes("API_KEY"), false);
});

test("并发指标写入保持 UTF-8 JSONL 行完整", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-metrics-utf8-"));
  const filePath = path.join(directory, "运行指标.jsonl");
  try {
    const base: RunMetrics = {
      schemaVersion: 1,
      scope: "model_run",
      runId: "中文运行",
      taskSessionId: "任务-1",
      provider: "mock",
      model: "mock",
      mode: "act",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      durationMs: 1,
      firstTokenLatencyMs: null,
      firstTokenLatencySource: "unavailable",
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      estimatedCostUsd: null,
      safeEditorNeedsAnalysisCount: 0,
      safeEditorAutoAnalysisAttemptCount: 0,
      safeEditorAutoAnalysisSuccessCount: 0,
      safeEditorConfirmedExpansionCount: 0,
      safeEditorRiskAcknowledgementCount: 0,
      safeEditorFalseExpansionRegressionCount: 0,
      completionRequestCount: 0,
      completionAcceptedCount: 0,
      completionRejectedCount: 0,
      sameEvidenceRejectionCount: 0,
      approvalResumeCount: 0,
      mutationEvidenceRestoreFailureCount: 0,
      completionLoopStoppedCount: 0,
      providerCallCount: 0,
      providerCallsAfterFirstCompletionRejection: 0,
      changedFileCount: 0,
      inputTokensPerChangedFile: null,
      contextCompressionCount: 0,
      completionResourceAlerts: [],
      completionRejections: [],
      taskSessionPersistence: {
        taskSessionUpdateCount: 0,
        taskSessionPhysicalWriteCount: 0,
        taskSessionWriteSkippedCount: 0,
        taskSessionWriteCoalescedCount: 0,
        taskSessionRenameRetryCount: 0
      },
      progressiveDelivery: createEmptyProgressiveDeliveryMetrics(),
      tools: {
        calls: 0,
        repeatedCalls: 0,
        cacheHits: 0,
        emptyResults: 0,
        invalidToolCalls: 0,
        consecutiveNoProgressSteps: 0,
        maxConsecutiveNoProgressSteps: 0,
        recoveryAttempts: 0,
        failedCalls: 0,
        mostRepeatedCall: null
      },
      context: { compressionCount: 0, estimatedTokensBefore: null, estimatedTokensAfter: null, estimator: "unavailable" },
      result: {
        status: "incomplete",
        stopReason: "incomplete",
        failureCategory: "none",
        patchFileCount: 0,
        validationCommandCount: 0,
        validationStatus: "not_run"
      }
    };

    await Promise.all(Array.from({ length: 12 }, (_, index) => appendRunMetrics({ ...base, runId: `中文运行-${index}` }, filePath)));
    const raw = await fs.readFile(filePath, "utf8");
    const records = raw.trim().split(/\r?\n/).map((line) => JSON.parse(line) as RunMetrics);
    assert.equal(records.length, 12);
    assert.equal(new Set(records.map((record) => record.runId)).size, 12);
    assert.equal(raw.includes("中文运行"), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("失败分类区分超时、模型、工具、验证和取消", () => {
  assert.equal(classifyRunFailure({ code: "ETIMEDOUT" }), "timeout");
  assert.equal(classifyRunFailure({ status: 429 }), "model_error");
  assert.equal(classifyRunFailure({ category: "tool_error" }), "tool_error");
  assert.equal(classifyRunFailure(new Error("validation failed")), "validation_failure");
  assert.equal(classifyRunFailure({ name: "AbortError" }), "cancelled");
});

test("运行指标保留 incomplete 与 blocked 停止原因", async () => {
  const incomplete = await new RunMetricsTracker(
    { runId: "incomplete-run", taskSessionId: null, provider: "mock", model: "mock", mode: "act" },
    async () => undefined,
    false
  ).finish({ status: "incomplete" });
  const blocked = await new RunMetricsTracker(
    { runId: "blocked-run", taskSessionId: null, provider: "mock", model: "mock", mode: "act" },
    async () => undefined,
    false
  ).finish({ status: "blocked" });

  assert.equal(incomplete.result.stopReason, "incomplete");
  assert.equal(blocked.result.stopReason, "blocked");
});

test("Mock Agent 完成后生成一条完整运行指标", async () => {
  let captured: RunMetrics | undefined;
  const result = await runAgentRuntime({
    userRequest: "生成基线指标",
    projectMemoryPrompt: "",
    registry: createAgentToolRegistry([]),
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "done" } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 }
    }),
    metricsRecorder: async (metrics) => { captured = metrics; }
  });

  assert.equal(result.status, "completed");
  assert.equal(captured?.result.status, "completed");
  assert.equal(captured?.usage.inputTokens, 12);
  assert.equal(captured?.firstTokenLatencySource, "completion_upper_bound");
  assert.equal(typeof captured?.firstTokenLatencyMs, "number");
  assert.equal(captured?.taskSessionId, null);
});

test("阶段六影子指标只保留交付单元元数据、失败类别和恢复结果", async () => {
  const tracker = new RunMetricsTracker({ runId: "stage6-shadow", taskSessionId: "stage6-task", provider: "mock", model: "mock", mode: "act" }, async () => {});
  tracker.recordDeliveryUnitSnapshot([{
    version: 1, id: "unit-safe-id", title: "不得写入指标", sourcePlanItemIds: ["plan-1"], status: "validated",
    completionCriteria: [], candidateFiles: ["secret.ts"], filesRead: [], plannedFiles: [], dependencyUnitIds: [], checkpointIds: [], verificationCommands: ["private command"],
    contextMetrics: { inputTokens: 123, compressionCount: 2, toolCallCount: 3, changedFileCount: 1, validationResult: "passed", updatedAt: Date.now() }, createdAt: Date.now(), updatedAt: Date.now()
  }]);
  tracker.recordToolFailureDiagnostic({ errorCategory: "transient" });
  tracker.recordRecoveryDecision("replan");
  const metrics = await tracker.finish({ status: "completed" });
  assert.deepEqual(metrics.progressiveDelivery.deliveryUnits, { total: 1, completed: 1, blocked: 0, deferred: 0 });
  assert.equal(metrics.progressiveDelivery.toolFailuresByCategory.transient, 1);
  assert.equal(metrics.progressiveDelivery.noProgressTransitions.replan, 1);
  assert.equal(metrics.progressiveDelivery.noProgressTransitions.successfulDelivery, 1);
  const serialized = JSON.stringify(metrics.progressiveDelivery);
  assert.equal(serialized.includes("不得写入指标"), false);
  assert.equal(serialized.includes("secret.ts"), false);
  assert.equal(serialized.includes("private command"), false);
});
