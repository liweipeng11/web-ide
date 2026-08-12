import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import { parseJsonModelResponse } from "../modelJsonResponse.js";
import { PLANNER_CREATE_SYSTEM_PROMPT, PLANNER_REPLAN_SYSTEM_PROMPT } from "./prompt.js";

export interface PlannerAgentDecisionModel {
  createPlan(input: string, signal?: AbortSignal): Promise<unknown>;
  replan(input: string, signal?: AbortSignal): Promise<unknown>;
  /**
   * 规划阶段的只读工具循环。保留为可选字段，以兼容仅支持一次性 JSON
   * 规划结果的测试替身和旧模型适配器。
   */
  nextAction?(input: string, signal?: AbortSignal): Promise<unknown>;
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
    return parseJsonModelResponse({ agentName: "Planner", content: response.message.content, reasoningContent: response.message.reasoningContent }).value;
  }

  createPlan(input: string, signal?: AbortSignal) {
    return this.complete(PLANNER_CREATE_SYSTEM_PROMPT, input, signal);
  }

  replan(input: string, signal?: AbortSignal) {
    return this.complete(PLANNER_REPLAN_SYSTEM_PROMPT, input, signal);
  }

  nextAction(input: string, signal?: AbortSignal) {
    // 工具循环的请求会携带阶段标记；据此保留 create 与 replan 的约束差异。
    return this.complete(input.includes('"phase":"replan"') ? PLANNER_REPLAN_SYSTEM_PROMPT : PLANNER_CREATE_SYSTEM_PROMPT, input, signal);
  }
}
