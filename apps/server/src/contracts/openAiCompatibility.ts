import type { AgentCompletionResponse, AgentMessage } from "../agentToolTypes.js";
import type { ModelMessage, ModelRequest, ModelResponse, ModelToolCall, ModelUsage } from "./model.js";

type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiCompletionResponse = AgentCompletionResponse & {
  usage?: OpenAiUsage;
  choices?: Array<NonNullable<AgentCompletionResponse["choices"]>[number] & { finish_reason?: string }>;
};

function parseToolArguments(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toModelToolCall(toolCall: OpenAiToolCall): ModelToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseToolArguments(toolCall.function.arguments),
    rawArguments: toolCall.function.arguments
  };
}

export function adaptOpenAiCompletionResponse(response: OpenAiCompletionResponse): ModelResponse {
  const choice = response.choices?.[0];
  const message = choice?.message;

  if (!message) {
    throw new Error("AI response did not include a message");
  }

  const usage: ModelUsage = {
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    reasoningTokens: response.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedInputTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0
  };

  return {
    message: {
      role: "assistant",
      content: message.content,
      toolCalls: message.tool_calls?.map(toModelToolCall)
    },
    usage,
    finishReason: choice.finish_reason
  };
}

function toOpenAiMessage(message: ModelMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: { name: toolCall.name, arguments: toolCall.rawArguments ?? JSON.stringify(toolCall.arguments) }
    }))
  };
}

// 兼容期只在边界转换 OpenAI 字段，业务层统一使用内部契约。
export function toOpenAiChatCompletionBody(request: ModelRequest) {
  return {
    model: request.model,
    temperature: request.temperature,
    messages: request.messages.map(toOpenAiMessage),
    tools: request.tools,
    tool_choice: request.toolChoice,
    response_format: request.responseFormat ? { type: request.responseFormat } : undefined
  };
}

export function fromOpenAiChatCompletionBody(body: Record<string, unknown>): ModelRequest {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    model: typeof body.model === "string" ? body.model : "",
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    messages: messages.map((message) => {
      const value = message as AgentMessage;
      return {
        role: value.role,
        content: value.content,
        toolCallId: value.tool_call_id,
        toolCalls: value.tool_calls?.map(toModelToolCall)
      };
    }),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    toolChoice: body.tool_choice === "none" || body.tool_choice === "required" ? body.tool_choice : body.tool_choice ? "auto" : undefined,
    responseFormat: (body.response_format as { type?: unknown } | undefined)?.type === "json_object" ? "json_object" : undefined
  };
}
