import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { providerGateway } from "../../providers/index.js";
import { MAIN_ACTION_SYSTEM_PROMPT, MAIN_ROUTE_SYSTEM_PROMPT, MAIN_SUMMARY_SYSTEM_PROMPT } from "./prompt.js";

export interface MainAgentDecisionModel {
  route(userRequest: string): Promise<unknown>;
  nextAction(input: string): Promise<unknown>;
  summarize?(input: string): Promise<unknown>;
}

function parseJsonResponse(content: string | null | undefined) {
  if (!content?.trim()) throw new Error("Main Agent 模型没有返回内容。");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized) as unknown;
}

/** 复用项目现有 Provider Gateway，Main Agent 不依赖任何供应商私有协议。 */
export class ProviderMainAgentDecisionModel implements MainAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  private async complete(systemPrompt: string, content: string) {
    const selection = this.selection ?? getModelExecutionContext()?.selection ?? {
      providerId: "openai-compatible",
      modelId: config.aiModel
    };
    const response = await providerGateway.complete(selection, {
      systemPrompt,
      messages: [{ role: "user", content }],
      temperature: 0,
      responseFormat: "json_object"
    });
    return parseJsonResponse(response.message.content);
  }

  route(userRequest: string) {
    return this.complete(MAIN_ROUTE_SYSTEM_PROMPT, userRequest);
  }

  nextAction(input: string) {
    return this.complete(MAIN_ACTION_SYSTEM_PROMPT, input);
  }

  summarize(input: string) {
    return this.complete(MAIN_SUMMARY_SYSTEM_PROMPT, input);
  }
}
