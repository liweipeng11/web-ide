import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRunMetrics, classifyRunFailure, RunMetricsTracker } from "./runMetrics.js";
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
    assert.equal(log.includes("Authorization"), false);
    assert.equal(log.includes("API_KEY"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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
