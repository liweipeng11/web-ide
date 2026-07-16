import test from "node:test";
import assert from "node:assert/strict";
import type { ModelDescriptor, ModelEvent, ModelRequest, ModelResponse, ProviderHealth } from "../contracts/model.js";
import { ProviderGateway } from "./providerGateway.js";
import { ProviderError, type ModelProvider } from "./types.js";

function descriptor(toolCalling = true): ModelDescriptor {
  return {
    id: toolCalling ? "tool-model" : "chat-model",
    providerId: "mock",
    displayName: toolCalling ? "Tool Model" : "Chat Model",
    capabilities: { contextWindowTokens: 32_000, maxOutputTokens: 4_000, toolCalling, parallelToolCalling: false, imageInput: false, reasoningEffort: false, promptCache: false }
  };
}

class MockProvider implements ModelProvider {
  id = "mock";
  async listModels() { return [descriptor(true), descriptor(false)]; }
  async validateConfig(): Promise<ProviderHealth> { return { configured: true, available: true }; }
  async complete(request: ModelRequest): Promise<ModelResponse> { return { message: { role: "assistant", content: request.model }, usage: { inputTokens: 3, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 } }; }
  async *stream(): AsyncIterable<ModelEvent> { yield { type: "text_delta", delta: "ok" }; yield { type: "done" }; }
}

test("Gateway 通过内部契约选择 Provider 并保留 Usage", async () => {
  const gateway = new ProviderGateway([new MockProvider()]);
  const response = await gateway.complete({ providerId: "mock", modelId: "tool-model" }, { messages: [{ role: "user", content: "hello" }] });
  assert.equal(response.message.content, "tool-model");
  assert.equal(response.usage.inputTokens, 3);
  assert.equal((await gateway.listCatalog())[0].health.configured, true);
});

test("Act 模式在请求前阻止不支持工具调用的模型", async () => {
  const gateway = new ProviderGateway([new MockProvider()]);
  await assert.rejects(() => gateway.assertCompatible({ providerId: "mock", modelId: "chat-model" }, "act"), (error: unknown) => error instanceof ProviderError && error.code === "invalid_response");
  await gateway.assertCompatible({ providerId: "mock", modelId: "chat-model" }, "chat");
});
