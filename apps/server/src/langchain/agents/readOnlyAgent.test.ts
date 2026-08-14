import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import type { RuntimeToolDescriptor } from "../../runtime/contracts.js";
import { runReadOnlyAgent, type ReadOnlyAgentModel } from "./readOnlyAgent.js";
import { createReadOnlyToolRegistry } from "./readOnlyToolRegistry.js";

class ScriptedModel implements ReadOnlyAgentModel {
  readonly visibleToolNames: string[][] = [];
  private cursor = 0;

  constructor(private readonly responses: AIMessage[]) {}

  async invoke(_messages: readonly BaseMessage[], options: { tools: readonly DynamicStructuredTool[]; signal?: AbortSignal }) {
    this.visibleToolNames.push(options.tools.map((tool) => tool.name));
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const response = this.responses[this.cursor++];
    if (!response) throw new Error("模型脚本耗尽");
    return response;
  }
}

const descriptors: RuntimeToolDescriptor[] = [
  { name: "grep", description: "搜索", effect: "read", inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
  { name: "read_file", description: "读取", effect: "read", inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
  { name: "writeFile", description: "写入", effect: "write", inputSchema: { type: "object" } }
];

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });
}

test("只读 Agent 完成搜索、读取和最终回答循环", async () => {
  const calls: string[] = [];
  const model = new ScriptedModel([
    toolCall("call-1", "grep", { pattern: "auth" }),
    toolCall("call-2", "read_file", { filePath: "src/auth.ts" }),
    new AIMessage("认证入口位于 src/auth.ts。")
  ]);
  const registry = createReadOnlyToolRegistry(descriptors, async (name) => {
    calls.push(name);
    return name === "grep" ? { files: ["src/auth.ts"] } : { content: "export function auth() {}" };
  });

  const result = await runReadOnlyAgent({ goal: "认证入口在哪里？", model, registry });

  assert.equal(result.state.status, "completed");
  assert.equal(result.state.finalAnswer, "认证入口位于 src/auth.ts。");
  assert.equal(result.state.readFileCount, 1);
  assert.deepEqual(calls, ["grep", "read_file"]);
  assert.equal(model.visibleToolNames.every((names) => !names.includes("writeFile")), true);
});

test("模型伪造写工具调用会被拒绝且不会委托 Runtime", async () => {
  let runtimeCalls = 0;
  const model = new ScriptedModel([
    toolCall("write-1", "writeFile", { filePath: "src/a.ts", content: "changed" }),
    new AIMessage("无法执行写入；仅提供分析结果。")
  ]);
  const registry = createReadOnlyToolRegistry(descriptors, async () => {
    runtimeCalls += 1;
    return null;
  });

  const result = await runReadOnlyAgent({ goal: "分析并尝试修改", model, registry });
  assert.equal(result.state.status, "completed");
  assert.equal(runtimeCalls, 0);
  assert.equal(result.messages.some((message) => message.getType() === "tool" && String(message.content).includes("无权调用")), true);
});

test("相同只读调用只执行一次，并允许模型在收到抑制结果后完成", async () => {
  let runtimeCalls = 0;
  const model = new ScriptedModel([
    toolCall("grep-1", "grep", { pattern: "router" }),
    toolCall("grep-2", "grep", { pattern: "router" }),
    new AIMessage("未发现 router。")
  ]);
  const registry = createReadOnlyToolRegistry(descriptors, async () => {
    runtimeCalls += 1;
    return { files: [] };
  });

  const result = await runReadOnlyAgent({ goal: "查找 router", model, registry });
  assert.equal(result.state.status, "completed");
  assert.equal(runtimeCalls, 1);
  assert.equal(result.messages.some((message) => message.getType() === "tool" && String(message.content).includes("重复")), true);
});

test("只读 Agent 在预算耗尽或取消时安全停止", async (context) => {
  await context.test("工具预算耗尽", async () => {
    const model = new ScriptedModel([
      toolCall("grep-1", "grep", { pattern: "a" }),
      toolCall("grep-2", "grep", { pattern: "b" })
    ]);
    const registry = createReadOnlyToolRegistry(descriptors, async () => ({}));
    const result = await runReadOnlyAgent({ goal: "搜索", model, registry, limits: { maxToolCalls: 1 } });
    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /最大工具调用数/);
  });

  await context.test("用户预先取消", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new ScriptedModel([new AIMessage("不应调用")]);
    const registry = createReadOnlyToolRegistry(descriptors, async () => ({}));
    const result = await runReadOnlyAgent({ goal: "分析", model, registry, signal: controller.signal });
    assert.equal(result.state.status, "cancelled");
    assert.equal(model.visibleToolNames.length, 0);
  });

  await context.test("读取预算耗尽", async () => {
    const model = new ScriptedModel([
      toolCall("read-1", "read_file", { filePath: "src/a.ts" }),
      toolCall("read-2", "read_file", { filePath: "src/b.ts" })
    ]);
    const registry = createReadOnlyToolRegistry(descriptors, async () => ({ content: "ok" }));
    const result = await runReadOnlyAgent({ goal: "读取", model, registry, limits: { maxReadFiles: 1 } });
    assert.equal(result.state.status, "failed");
    assert.match(result.state.error ?? "", /最大读取文件数/);
  });
});
