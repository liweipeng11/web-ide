import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import { DEVELOPER_SYSTEM_PROMPT } from "./prompt.js";

export interface DeveloperAgentDecisionModel {
  nextAction(input: string, signal?: AbortSignal): Promise<unknown>;
}

function parseJsonResponse(content: string | null | undefined) {
  if (!content?.trim()) throw new Error("Developer Agent 模型没有返回内容。");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized) as unknown;
}

/** 复用项目 Provider Gateway，Developer 不依赖具体模型供应商协议。 */
export class ProviderDeveloperAgentDecisionModel implements DeveloperAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  async nextAction(input: string, signal?: AbortSignal) {
    const selection = this.selection ?? getModelExecutionContext()?.selection ?? {
      providerId: "openai-compatible",
      modelId: config.aiModel
    };
    const response = await requestModelCompletionWithMetrics(selection, {
      systemPrompt: DEVELOPER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      temperature: 0,
      responseFormat: "json_object"
    }, signal);
    return parseJsonResponse(response.message.content);
  }
}
