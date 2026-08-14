import { BaseChatModel, type BaseChatModelCallOptions } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { ModelRequest, ModelResponse, ModelSelection } from "../../contracts/model.js";
import {
  fromLangChainMessage,
  modelResponseFromLangChainMessage,
  toLangChainMessages
} from "./messageAdapter.js";

export type ProviderModelExecutor = (
  selection: ModelSelection,
  request: Omit<ModelRequest, "model">,
  signal?: AbortSignal
) => Promise<ModelResponse>;

export type ProviderChatModelOptions = {
  selection: ModelSelection;
  request: Omit<ModelRequest, "model" | "messages">;
  execute: ProviderModelExecutor;
};

/**
 * LangChain 模型适配器只负责协议转换；重试、预算、指标和 Provider 选择仍由现有 Gateway 负责。
 */
export class ProviderGatewayChatModel extends BaseChatModel<BaseChatModelCallOptions> {
  constructor(private readonly options: ProviderChatModelOptions) {
    super({});
  }

  _llmType(): string {
    return "mini-ai-provider-gateway";
  }

  override invocationParams() {
    return {
      provider: this.options.selection.providerId,
      model: this.options.selection.modelId
    };
  }

  async _generate(messages: BaseMessage[], callOptions: this["ParsedCallOptions"]): Promise<ChatResult> {
    const response = await this.options.execute(this.options.selection, {
      ...this.options.request,
      messages: messages.map(fromLangChainMessage)
    }, callOptions.signal);
    const usage = response.usage;
    const message = new AIMessage({
      content: response.message.content ?? "",
      tool_calls: response.message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
        args: call.arguments,
        type: "tool_call" as const
      })),
      additional_kwargs: response.message.reasoningContent
        ? { reasoning_content: response.message.reasoningContent }
        : {},
      response_metadata: { finishReason: response.finishReason },
      usage_metadata: {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        input_token_details: { cache_read: usage.cachedInputTokens },
        output_token_details: { reasoning: usage.reasoningTokens }
      }
    });
    return { generations: [{ text: response.message.content ?? "", message }] };
  }
}

/** 通过标准 LangChain invoke 路径调用现有 Provider Gateway。 */
export async function invokeProviderChatModel(input: {
  selection: ModelSelection;
  request: Omit<ModelRequest, "model">;
  execute: ProviderModelExecutor;
  signal?: AbortSignal;
}): Promise<ModelResponse> {
  const { messages, ...request } = input.request;
  const model = new ProviderGatewayChatModel({
    selection: input.selection,
    request,
    execute: input.execute
  });
  const result = await model.invoke(toLangChainMessages(messages), { signal: input.signal });
  return modelResponseFromLangChainMessage(result);
}
