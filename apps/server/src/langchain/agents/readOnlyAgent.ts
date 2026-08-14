import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { AgentRuntimeError } from "../../runtime/errors.js";
import {
  advanceReadOnlyAgentState,
  createReadOnlyAgentState,
  failReadOnlyAgentState,
  finishReadOnlyAgentState,
  type ReadOnlyAgentLimits,
  type ReadOnlyAgentState
} from "./readOnlyAgentState.js";
import type { ReadOnlyToolRegistry } from "./readOnlyToolRegistry.js";

const READ_FILE_TOOL_NAMES = new Set(["read_file", "readFile"]);

export type ReadOnlyAgentModel = {
  invoke: (
    messages: readonly BaseMessage[],
    options: { tools: readonly DynamicStructuredTool[]; signal?: AbortSignal }
  ) => Promise<AIMessage>;
};

export type ReadOnlyAgentRunOptions = {
  goal: string;
  model: ReadOnlyAgentModel;
  registry: ReadOnlyToolRegistry;
  limits?: ReadOnlyAgentLimits;
  signal?: AbortSignal;
  systemPrompt?: string;
};

export type ReadOnlyAgentRunResult = {
  state: ReadOnlyAgentState;
  messages: BaseMessage[];
};

const DEFAULT_SYSTEM_PROMPT = [
  "你是项目只读分析智能体。",
  "只能使用已提供的搜索和读取工具，不得修改文件、执行命令或申请扩大权限。",
  "证据足够后直接给出简洁答案；不知道时明确说明缺失信息。"
].join("\n");

/**
 * 使用 LangChain 标准消息与工具执行最小只读循环。
 * 生产选择、shadow 对照和持久化由后续工作包负责，本函数没有任何写入入口。
 */
export async function runReadOnlyAgent(options: ReadOnlyAgentRunOptions): Promise<ReadOnlyAgentRunResult> {
  let state = createReadOnlyAgentState(options.goal, options.limits);
  const messages: BaseMessage[] = [
    new SystemMessage(options.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT),
    new HumanMessage(state.goal)
  ];
  const executedCalls = new Set<string>();

  while (state.status === "running") {
    if (options.signal?.aborted) {
      state = failReadOnlyAgentState(state, "cancelled", "用户已取消只读分析。");
      break;
    }
    if (state.stepCount >= state.maxSteps) {
      state = failReadOnlyAgentState(state, "failed", `只读 Agent 达到最大步骤数：${state.maxSteps}`);
      break;
    }

    let response: AIMessage;
    try {
      response = await options.model.invoke(messages, { tools: options.registry.tools, signal: options.signal });
    } catch (error) {
      const cancelled = options.signal?.aborted || isAbortError(error);
      state = failReadOnlyAgentState(
        state,
        cancelled ? "cancelled" : "failed",
        cancelled ? "用户已取消只读分析。" : "只读模型调用失败。"
      );
      break;
    }

    messages.push(response);
    const toolCalls = response.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const answer = messageText(response).trim();
      state = advanceReadOnlyAgentState(state);
      state = answer
        ? finishReadOnlyAgentState(state, answer)
        : failReadOnlyAgentState(state, "failed", "只读模型未返回答案或工具调用。");
      break;
    }

    for (const call of toolCalls) {
      if (state.stepCount >= state.maxSteps || state.toolCallCount >= state.maxToolCalls) {
        const reason = state.toolCallCount >= state.maxToolCalls
          ? `只读 Agent 达到最大工具调用数：${state.maxToolCalls}`
          : `只读 Agent 达到最大步骤数：${state.maxSteps}`;
        state = failReadOnlyAgentState(state, "failed", reason);
        break;
      }

      const callId = call.id ?? `tool-call-${state.toolCallCount + 1}`;
      const args = isRecord(call.args) ? call.args : {};
      const fingerprint = `${call.name}:${stableJson(args)}`;
      if (READ_FILE_TOOL_NAMES.has(call.name) && state.readFileCount >= state.maxReadFiles) {
        state = failReadOnlyAgentState(state, "failed", `只读 Agent 达到最大读取文件数：${state.maxReadFiles}`);
        break;
      }
      state = advanceReadOnlyAgentState(state, {
        toolCall: { id: callId, name: call.name },
        readFiles: READ_FILE_TOOL_NAMES.has(call.name) ? 1 : 0
      });

      if (executedCalls.has(fingerprint)) {
        // 重复调用仍回传 ToolMessage，让模型可以修正，而不是再次读取同一资源。
        messages.push(toolMessage(callId, { error: "重复只读工具调用已抑制。" }));
        continue;
      }
      executedCalls.add(fingerprint);

      try {
        const tool = options.registry.tools.find((item) => item.name === call.name);
        const result = tool
          ? await tool.invoke(args, { signal: options.signal })
          : await options.registry.call(call.name, args);
        messages.push(toolMessage(callId, result));
      } catch (error) {
        messages.push(toolMessage(callId, {
          error: error instanceof AgentRuntimeError ? error.message : "只读工具执行失败。"
        }));
      }
    }
  }

  return { state, messages };
}

function messageText(message: AIMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function toolMessage(toolCallId: string, value: unknown): ToolMessage {
  return new ToolMessage({ content: safeJson(value), tool_call_id: toolCallId });
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify({ error: "工具结果无法序列化。" });
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
