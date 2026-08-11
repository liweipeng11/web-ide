import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import { PLANNER_CREATE_SYSTEM_PROMPT, PLANNER_REPLAN_SYSTEM_PROMPT } from "./prompt.js";

export interface PlannerAgentDecisionModel {
  createPlan(input: string, signal?: AbortSignal): Promise<unknown>;
  replan(input: string, signal?: AbortSignal): Promise<unknown>;
}

function parseJsonResponse(content: string | null | undefined) {
  if (!content?.trim()) throw new Error("Planner Agent 模型没有返回内容。");
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(normalized) as unknown;
}

/** 复用 Provider Gateway，避免 Planner 与具体模型供应商耦合。 */
export class ProviderPlannerAgentDecisionModel implements PlannerAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  private async complete(systemPrompt: string, content: string, signal?: AbortSignal) {
    // 生产任务优先复用当前 AsyncLocalStorage 中的模型选择，测试和独立调用仍可显式注入。
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

  createPlan(input: string, signal?: AbortSignal) {
    return this.complete(PLANNER_CREATE_SYSTEM_PROMPT, input, signal);
  }

  replan(input: string, signal?: AbortSignal) {
    return this.complete(PLANNER_REPLAN_SYSTEM_PROMPT, input, signal);
  }
}
