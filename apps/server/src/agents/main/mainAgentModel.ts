import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import { parseJsonModelResponse } from "../modelJsonResponse.js";
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
    return parseJsonModelResponse({ agentName: "Main", content: response.message.content, reasoningContent: response.message.reasoningContent }).value;
  }

  route(userRequest: string, signal?: AbortSignal) {
    return this.complete(MAIN_ROUTE_SYSTEM_PROMPT, userRequest, signal);
  }

  nextAction(input: string, signal?: AbortSignal) {
    return this.completeMainAction(input, signal);
  }

  private async completeMainAction(input: string, signal?: AbortSignal) {
    const first = await this.complete(MAIN_ACTION_SYSTEM_PROMPT, input, signal);
    if (hasActionType(first)) return first;

    const repaired = await this.complete(
      `${MAIN_ACTION_SYSTEM_PROMPT}\n\n上一次响应缺少 type 字段。请严格返回上述某一种 NextAction；工具调用必须使用 {"type":"tool","tool":"工具名","args":{}}，不要返回 name/tool_calls 包装。`,
      input,
      signal
    );
    if (!hasActionType(repaired)) {
      throw new Error("Main Agent 响应协议错误：模型未返回包含 type 字段的完整 NextAction，已自动重试 1 次。");
    }
    return repaired;
  }

  summarize(input: string, signal?: AbortSignal) {
    return this.complete(MAIN_SUMMARY_SYSTEM_PROMPT, input, signal);
  }

  shouldReplan(input: string, signal?: AbortSignal) {
    return this.complete(MAIN_REPLAN_SYSTEM_PROMPT, input, signal);
  }
}

function hasActionType(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === "string");
}
