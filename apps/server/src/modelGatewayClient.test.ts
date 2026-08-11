import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { requestChatCompletion, requestChatCompletionStream, requestModelCompletionWithMetrics } from "./modelGatewayClient.js";
import { withModelExecution } from "./modelExecutionContext.js";
import { clearTaskMetricsForTest, getTaskMetricsSnapshot } from "./observability/index.js";

test("Agent 模型入口只重试 Provider 明确标记的瞬时错误", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = config.aiApiKey;
  const originalModels = config.aiModels;
  const originalBaseDelay = config.agentRuntimeStabilityPolicy.retryBaseDelayMs;
  const originalMaxDelay = config.agentRuntimeStabilityPolicy.retryMaxDelayMs;
  const modelId = "stability-model";
  let calls = 0;
  config.aiApiKey = "test-key";
  config.aiModels = [modelId];
  config.agentRuntimeStabilityPolicy.retryBaseDelayMs = 1;
  config.agentRuntimeStabilityPolicy.retryMaxDelayMs = 1;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response("temporarily unavailable", { status: 503 });
    return new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "{}" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 }
    }), { status: 200 });
  };
  try {
    const response = await requestModelCompletionWithMetrics(
      { providerId: "openai-compatible", modelId },
      { messages: [{ role: "user", content: "test" }], responseFormat: "json_object" }
    );
    assert.equal(response.message.content, "{}");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    config.aiApiKey = originalKey;
    config.aiModels = originalModels;
    config.agentRuntimeStabilityPolicy.retryBaseDelayMs = originalBaseDelay;
    config.agentRuntimeStabilityPolicy.retryMaxDelayMs = originalMaxDelay;
  }
});

test("任务执行上下文覆盖请求体模型并记录普通聊天 Usage", async () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = config.featureFlags.modelProviderGateway;
  const originalKey = config.aiApiKey;
  const originalModels = config.aiModels;
  const originalStateDirectory = config.stateDirectory;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-gateway-client-"));
  const selectedModel = "context-selected-model";
  let requestedModel = "";
  let requestedMessages: Array<{ role: string; content?: string }> = [];
  config.featureFlags.modelProviderGateway = true;
  config.aiApiKey = "test-key";
  config.aiModels = [selectedModel];
  config.stateDirectory = directory;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: Array<{ role: string; content?: string }> };
    requestedModel = body.model;
    requestedMessages = body.messages;
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }), { status: 200 });
  };
  try {
    await clearTaskMetricsForTest({ memoryOnly: true });
    const response = await withModelExecution({ selection: { providerId: "openai-compatible", modelId: selectedModel }, taskSessionId: "task-model-context", mode: "chat" }, () => requestChatCompletion({
      model: "wrong-model",
      messages: [
        { role: "system", content: "固定规则" },
        { role: "user", content: "hello" },
        { role: "system", content: "动态状态" }
      ]
    }));
    const metrics = await getTaskMetricsSnapshot("task-model-context");
    assert.equal(requestedModel, selectedModel);
    assert.deepEqual(requestedMessages.map((message) => message.role), ["system", "user"]);
    assert.match(requestedMessages[0]?.content || "", /固定规则[\s\S]*动态状态/);
    assert.equal(response.choices?.[0]?.message?.content, "ok");
    assert.equal(metrics?.usage.inputTokens, 12);
    assert.equal(metrics?.usage.outputTokens, 4);
  } finally {
    globalThis.fetch = originalFetch;
    config.featureFlags.modelProviderGateway = originalFlag;
    config.aiApiKey = originalKey;
    config.aiModels = originalModels;
    config.stateDirectory = originalStateDirectory;
    await clearTaskMetricsForTest({ key: "task-model-context" });
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Gateway 开关关闭时保留旧传输路径", async () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = config.featureFlags.modelProviderGateway;
  let requestedModel = "";
  config.featureFlags.modelProviderGateway = false;
  globalThis.fetch = async (_url, init) => {
    requestedModel = (JSON.parse(String(init?.body)) as { model: string }).model;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "legacy" } }] }), { status: 200 });
  };
  try {
    const response = await requestChatCompletion({ model: "legacy-model", messages: [] });
    assert.equal(requestedModel, "legacy-model");
    assert.equal(response.choices?.[0]?.message?.content, "legacy");
  } finally { globalThis.fetch = originalFetch; config.featureFlags.modelProviderGateway = originalFlag; }
});

test("Gateway 流式客户端消费统一文本和 Usage 事件", async () => {
  const originalFetch = globalThis.fetch;
  const originalFlag = config.featureFlags.modelProviderGateway;
  const originalKey = config.aiApiKey;
  const originalModels = config.aiModels;
  const modelId = "stream-model";
  config.featureFlags.modelProviderGateway = true;
  config.aiApiKey = "test-key";
  config.aiModels = [modelId];
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { status: 200 });
  try {
    let visible = "";
    const answer = await withModelExecution({ selection: { providerId: "openai-compatible", modelId }, taskSessionId: null, mode: "chat" }, () => requestChatCompletionStream({ model: "ignored", messages: [] }, (delta) => { visible += delta; }));
    assert.equal(answer, "A");
    assert.equal(visible, "A");
  } finally { globalThis.fetch = originalFetch; config.featureFlags.modelProviderGateway = originalFlag; config.aiApiKey = originalKey; config.aiModels = originalModels; }
});
