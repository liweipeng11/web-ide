import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { providerGateway } from "../../providers/index.js";
import { EXPLORER_SYSTEM_PROMPT } from "./prompt.js";

export interface ExplorerAgentDecisionModel {
  nextAction(input: string): Promise<unknown>;
}

function parseJsonResponse(content: string | null | undefined) {
  if (!content?.trim()) throw new Error("Explorer Agent 模型没有返回内容。");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized) as unknown;
}

/** 复用项目 Provider Gateway，Explorer 不依赖具体模型供应商协议。 */
export class ProviderExplorerAgentDecisionModel implements ExplorerAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  async nextAction(input: string) {
    const selection = this.selection ?? getModelExecutionContext()?.selection ?? {
      providerId: "openai-compatible",
      modelId: config.aiModel
    };
    const response = await providerGateway.complete(selection, {
      systemPrompt: EXPLORER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      temperature: 0,
      responseFormat: "json_object"
    });
    return parseJsonResponse(response.message.content);
  }
}

