import test from "node:test";
import assert from "node:assert/strict";
import { adaptOpenAiCompletionResponse, toOpenAiChatCompletionBody } from "./openAiCompatibility.js";

test("OpenAI 兼容响应在边界转换为内部工具调用和 Usage", () => {
  const response = adaptOpenAiCompletionResponse({
    choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "readFile", arguments: '{"path":"src/a.ts"}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } }
  });

  assert.deepEqual(response.message.toolCalls?.[0].arguments, { path: "src/a.ts" });
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, cachedInputTokens: 3 });
});

test("内部请求只在 Provider 边界恢复 OpenAI 字段", () => {
  const body = toOpenAiChatCompletionBody({ model: "mock", messages: [{ role: "assistant", toolCalls: [{ id: "call-1", name: "readFile", arguments: { path: "src/a.ts" } }] }], toolChoice: "auto" });
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.messages[0].tool_calls?.[0].function.name, "readFile");
});

test("Provider 边界将所有系统指令合并到消息开头", () => {
  const body = toOpenAiChatCompletionBody({
    model: "mock",
    systemPrompt: "固定系统规则",
    messages: [
      { role: "user", content: "用户任务" },
      { role: "system", content: "动态工作流状态" },
      { role: "assistant", content: "处理中" }
    ]
  });

  assert.deepEqual(body.messages.map((message) => message.role), ["system", "user", "assistant"]);
  assert.match(body.messages[0]?.content || "", /固定系统规则/);
  assert.match(body.messages[0]?.content || "", /动态工作流状态/);
});
