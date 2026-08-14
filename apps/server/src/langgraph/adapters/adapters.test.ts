import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import type { ModelMessage } from "../../contracts/model.js";
import { adaptRuntimeToolsForLangChain } from "./runtimeToolAdapter.js";
import { fromLangChainMessage, toLangChainMessages } from "./messageAdapter.js";
import { invokeProviderChatModel } from "./providerChatModel.js";

test("消息适配器保留角色、工具调用和推理摘要", () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "系统" },
    { role: "user", content: "问题" },
    {
      role: "assistant",
      content: "",
      reasoningContent: "摘要",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" }, rawArguments: '{"path":"a.ts"}' }]
    },
    { role: "tool", content: "内容", toolCallId: "call-1" }
  ];
  const adapted = toLangChainMessages(messages);
  assert.deepEqual(adapted.map((message) => message.getType()), ["system", "human", "ai", "tool"]);
  assert.deepEqual(messages.map((_, index) => fromLangChainMessage(adapted[index])), messages);
  assert.throws(
    () => toLangChainMessages([{ role: "tool", content: "缺少 ID" }]),
    /缺少 toolCallId/
  );
});

test("Provider ChatModel 通过 LangChain invoke 复用现有 Gateway 执行器", async () => {
  const requests: unknown[] = [];
  const response = await invokeProviderChatModel({
    selection: { providerId: "test", modelId: "fake-model" },
    request: {
      messages: [{ role: "user", content: "你好" }],
      temperature: 0,
      toolChoice: "auto"
    },
    execute: async (selection, request) => {
      requests.push({ selection, request });
      return {
        message: {
          role: "assistant",
          content: "完成",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }]
        },
        usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1, reasoningTokens: 1 },
        finishReason: "tool_calls"
      };
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(response.message.content, "完成");
  assert.equal(response.message.toolCalls?.[0].name, "read_file");
  assert.deepEqual(response.usage, { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1, reasoningTokens: 1 });
  assert.equal(response.finishReason, "tool_calls");
});

test("Runtime Tool 适配器只委托受控 callTool，不直接执行副作用", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const [readTool] = adaptRuntimeToolsForLangChain([{
    name: "read_file",
    description: "读取文件",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  }], async (name, args) => {
    calls.push({ name, args });
    return { ok: true };
  });

  assert.deepEqual(await readTool.invoke({ path: "src/a.ts" }), { ok: true });
  assert.deepEqual(calls, [{ name: "read_file", args: { path: "src/a.ts" } }]);
});

test("LangChain AIMessage 可稳定还原空响应", () => {
  assert.deepEqual(fromLangChainMessage(new AIMessage("")), {
    role: "assistant",
    content: "",
    reasoningContent: undefined,
    toolCalls: []
  });
});
