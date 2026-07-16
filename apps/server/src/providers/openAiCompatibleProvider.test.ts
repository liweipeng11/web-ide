import test from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { ProviderError } from "./types.js";
import { config } from "../config.js";

const request = { model: "mock", messages: [{ role: "user" as const, content: "hello" }] };

test("OpenAI-compatible Provider 归一化消息、工具调用和 Usage", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "readFile", arguments: "{\"path\":\"a.ts\"}" } }] } }], usage: { prompt_tokens: 8, completion_tokens: 2 } }), { status: 200 });
  try {
    const response = await new OpenAiCompatibleProvider().complete(request);
    assert.deepEqual(response.message.toolCalls?.[0].arguments, { path: "a.ts" });
    assert.equal(response.usage.inputTokens, 8);
  } finally { globalThis.fetch = originalFetch; }
});

test("Provider 将 401 转换为统一认证错误且不暴露密钥", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 });
  try {
    await assert.rejects(() => new OpenAiCompatibleProvider().complete(request), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "authentication");
      assert.equal(error.message.includes("Bearer"), false);
      return true;
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("Provider 将 SSE 文本转换为统一流式事件", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { "Content-Type": "text/event-stream" } });
  try {
    const events = [];
    for await (const event of new OpenAiCompatibleProvider().stream(request)) events.push(event);
    assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : ""), ["你", "好"]);
    assert.equal(events.at(-1)?.type, "done");
  } finally { globalThis.fetch = originalFetch; }
});

test("Provider 归一化流式工具参数、Usage 和完成原因", async () => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    { choices: [{ delta: { reasoning_content: "分析中" }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "readFile", arguments: '{"path":' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } } }
  ];
  globalThis.fetch = async () => new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200 });
  try {
    const events = [];
    for await (const event of new OpenAiCompatibleProvider().stream(request)) events.push(event);
    assert.equal(events.some((event) => event.type === "tool_call_start"), true);
    assert.equal(events.some((event) => event.type === "reasoning_summary" && event.summary === "分析中"), true);
    assert.deepEqual(events.find((event) => event.type === "tool_call_end")?.type === "tool_call_end" ? events.find((event) => event.type === "tool_call_end")?.call.arguments : null, { path: "a.ts" });
    assert.equal(events.find((event) => event.type === "usage")?.type === "usage" ? events.find((event) => event.type === "usage")?.usage.inputTokens : null, 9);
    const finalEvent = events.at(-1);
    assert.equal(finalEvent?.type === "done" ? finalEvent.finishReason : null, "tool_calls");
  } finally { globalThis.fetch = originalFetch; }
});

test("模型目录支持逐模型能力、价格、推荐用途和禁用原因", async () => {
  const originalModels = config.aiModels;
  const originalCatalog = config.aiModelCatalog;
  config.aiModels = ["special-model"];
  config.aiModelCatalog = [{
    id: "special-model",
    displayName: "Special Model",
    capabilities: { contextWindowTokens: 64_000, maxOutputTokens: 2_000, toolCalling: false, parallelToolCalling: false, imageInput: true, reasoningEffort: true, promptCache: true },
    price: { inputPerMillionTokens: 1, outputPerMillionTokens: 5 },
    recommendedFor: ["chat"],
    disabledReason: "maintenance"
  }];
  try {
    const model = (await new OpenAiCompatibleProvider().listModels())[0];
    assert.equal(model.displayName, "Special Model");
    assert.equal(model.capabilities.toolCalling, false);
    assert.equal(model.capabilities.imageInput, true);
    assert.equal(model.price?.outputPerMillionTokens, 5);
    assert.deepEqual(model.recommendedFor, ["chat"]);
    assert.equal(model.disabledReason, "maintenance");
  } finally { config.aiModels = originalModels; config.aiModelCatalog = originalCatalog; }
});

for (const scenario of [
  { name: "429", fetch: async () => new Response("rate limited", { status: 429 }), code: "rate_limit" },
  { name: "5xx", fetch: async () => new Response("down", { status: 503 }), code: "unavailable" },
  { name: "无效 JSON", fetch: async () => new Response("{invalid", { status: 200 }), code: "invalid_response" },
  { name: "超时", fetch: async () => { throw new Error("connect timeout"); }, code: "timeout" }
]) {
  test(`Provider 将 ${scenario.name} 转换为统一错误`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = scenario.fetch;
    try {
      await assert.rejects(() => new OpenAiCompatibleProvider().complete(request), (error: unknown) => error instanceof ProviderError && error.code === scenario.code);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("中断流式请求后返回 cancelled 完成事件", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const controller = new AbortController();
  try {
    const eventsPromise = (async () => {
      const events = [];
      for await (const event of new OpenAiCompatibleProvider().stream(request, controller.signal)) events.push(event);
      return events;
    })();
    controller.abort();
    const events = await eventsPromise;
    const finalEvent = events.at(-1);
    assert.equal(finalEvent?.type === "done" ? finalEvent.finishReason : null, "cancelled");
  } finally { globalThis.fetch = originalFetch; }
});
