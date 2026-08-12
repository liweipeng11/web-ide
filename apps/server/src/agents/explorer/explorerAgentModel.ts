import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import { parseJsonModelResponse } from "../modelJsonResponse.js";
import { EXPLORER_SYSTEM_PROMPT } from "./prompt.js";

export interface ExplorerAgentDecisionModel {
  nextAction(input: string, signal?: AbortSignal): Promise<unknown>;
}

/** 复用项目 Provider Gateway，Explorer 不依赖具体模型供应商协议。 */
export class ProviderExplorerAgentDecisionModel implements ExplorerAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  async nextAction(input: string, signal?: AbortSignal) {
    const selection = this.selection ?? getModelExecutionContext()?.selection ?? {
      providerId: "openai-compatible",
      modelId: config.aiModel
    };
    const response = await requestModelCompletionWithMetrics(selection, {
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      temperature: 0,
      responseFormat: "json_object"
    }, signal);
    return parseJsonModelResponse({ agentName: "Explorer", content: response.message.content, reasoningContent: response.message.reasoningContent }).value;
  }
}
