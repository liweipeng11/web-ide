import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage
} from "@langchain/core/messages";
import type { ModelMessage, ModelResponse, ModelUsage } from "../../contracts/model.js";

function textContent(message: BaseMessage): string {
  if (typeof message.content === "string") return message.content;
  // 多模态内容暂未进入项目内部契约，仅保留其中的文本片段，避免隐式序列化二进制数据。
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

/** 将项目稳定消息契约转换为 LangChain 消息，第三方类型不会扩散到业务层。 */
export function toLangChainMessages(messages: readonly ModelMessage[]): BaseMessage[] {
  return messages.map((message) => {
    const content = message.content ?? "";
    if (message.role === "system") return new SystemMessage(content);
    if (message.role === "user") return new HumanMessage(content);
    if (message.role === "tool") {
      if (!message.toolCallId) throw new Error("Tool 消息缺少 toolCallId，无法转换为 LangChain 消息。");
      return new ToolMessage({ content, tool_call_id: message.toolCallId });
    }
    return new AIMessage({
      content,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.arguments,
        type: "tool_call" as const
      })),
      additional_kwargs: message.reasoningContent
        ? { reasoning_content: message.reasoningContent }
        : {}
    });
  });
}

/** 将 LangChain 消息还原为项目稳定消息契约。 */
export function fromLangChainMessage(message: BaseMessage): ModelMessage {
  const role = message.getType();
  if (role === "system") return { role: "system", content: textContent(message) };
  if (role === "human") return { role: "user", content: textContent(message) };
  if (role === "tool") {
    return {
      role: "tool",
      content: textContent(message),
      toolCallId: (message as ToolMessage).tool_call_id
    };
  }

  const aiMessage = message as AIMessage;
  return {
    role: "assistant",
    content: textContent(message),
    reasoningContent: typeof aiMessage.additional_kwargs.reasoning_content === "string"
      ? aiMessage.additional_kwargs.reasoning_content
      : undefined,
    toolCalls: aiMessage.tool_calls?.map((call) => ({
      id: call.id ?? `tool-call-${call.name}`,
      name: call.name,
      arguments: call.args,
      rawArguments: JSON.stringify(call.args)
    }))
  };
}

export function usageFromLangChainMessage(message: AIMessage): ModelUsage {
  const usage = message.usage_metadata;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedInputTokens: usage?.input_token_details?.cache_read ?? 0,
    reasoningTokens: usage?.output_token_details?.reasoning ?? 0
  };
}

export function modelResponseFromLangChainMessage(message: AIMessage): ModelResponse {
  return {
    message: fromLangChainMessage(message),
    usage: usageFromLangChainMessage(message),
    finishReason: typeof message.response_metadata.finishReason === "string"
      ? message.response_metadata.finishReason
      : undefined
  };
}
