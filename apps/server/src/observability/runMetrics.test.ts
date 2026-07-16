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
    tracker.recordToolCall();
    tracker.recordToolCall({ repeated: true });
    tracker.recordToolFailure();
    const metrics = await tracker.finish({ status: "completed", patchFileCount: 2, validationCommandCount: 1, validationStatus: "passed" });
    const log = await fs.readFile(filePath, "utf8");

    assert.deepEqual(metrics.tools, { calls: 2, repeatedCalls: 1, failedCalls: 1 });
    assert.equal(metrics.usage.cachedInputTokens, 4);
    assert.equal(metrics.estimatedCostUsd, 0.000032);
    assert.equal(metrics.result.patchFileCount, 2);
    assert.equal(metrics.firstTokenLatencyMs, 25);
    assert.equal(metrics.firstTokenLatencySource, "provider");
    assert.equal(log.includes("Authorization"), false);
    assert.equal(log.includes("API_KEY"), false);
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
