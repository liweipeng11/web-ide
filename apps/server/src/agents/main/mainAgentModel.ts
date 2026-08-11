import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import {
  MAIN_ACTION_SYSTEM_PROMPT,
  MAIN_REPLAN_SYSTEM_PROMPT,
  MAIN_ROUTE_SYSTEM_PROMPT,
  MAIN_SUMMARY_SYSTEM_PROMPT
} from "./prompt.js";

export interface MainAgentDecisionModel {
  route(userRequest: string, signal?: AbortSignal): Promise<unknown>;
  nextAction(input: string, signal?: AbortSignal): Promise<unknown>;
  summarize?(input: string, signal?: AbortSignal): Promise<unknown>;
  shouldReplan?(input: string, signal?: AbortSignal): Promise<unknown>;
}

function parseJsonResponse(content: string | null | undefined) {
  if (!content?.trim()) throw new Error("Main Agent 模型没有返回内容。");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized) as unknown;
}

/** 复用项目现有 Provider Gateway，Main Agent 不依赖任何供应商私有协议。 */
export class ProviderMainAgentDecisionModel implements MainAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  private async complete(systemPrompt: string, content: string, signal?: AbortSignal) {
    const selection = this.selection ?? getModelExecutionContext()?.selection ?? {
      providerId: "openai-compatible",
      modelId: config.aiModel
    };
    const response = await requestModelCompletionWithMetrics(selection, {
      systemPrompt,
      messages: [{ role: "user", content }],
      temperature: 0,
      responseFormat: "json_object"
    }, signal);
    return parseJsonResponse(response.message.content);
  }

  route(userRequest: string, signal?: AbortSignal) {
    return this.complete(MAIN_ROUTE_SYSTEM_PROMPT, userRequest, signal);
  }

  nextAction(input: string, signal?: AbortSignal) {
    return this.complete(MAIN_ACTION_SYSTEM_PROMPT, input, signal);
  }

  summarize(input: string, signal?: AbortSignal) {
    return this.complete(MAIN_SUMMARY_SYSTEM_PROMPT, input, signal);
  }

  shouldReplan(input: string, signal?: AbortSignal) {
    return this.complete(MAIN_REPLAN_SYSTEM_PROMPT, input, signal);
  }
}
