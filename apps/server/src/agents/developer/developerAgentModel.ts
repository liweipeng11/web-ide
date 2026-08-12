import type { ModelSelection } from "../../contracts/model.js";
import { config } from "../../config.js";
import { getModelExecutionContext } from "../../modelExecutionContext.js";
import { requestModelCompletionWithMetrics } from "../../modelGatewayClient.js";
import { parseJsonModelResponse } from "../modelJsonResponse.js";
import { DEVELOPER_SYSTEM_PROMPT } from "./prompt.js";

export interface DeveloperAgentDecisionModel {
  nextAction(input: string, signal?: AbortSignal): Promise<unknown>;
}

function hasActionType(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string");
}

/** 复用项目 Provider Gateway，Developer 不依赖具体模型供应商协议。 */
export class ProviderDeveloperAgentDecisionModel implements DeveloperAgentDecisionModel {
  constructor(private readonly selection?: ModelSelection) {}

  async nextAction(input: string, signal?: AbortSignal) {
    const selection = this.selection ?? getModelExecutionContext()?.selection ?? {
      providerId: "openai-compatible",
      modelId: config.aiModel
    };
    const request = async (repair: boolean) => requestModelCompletionWithMetrics(selection, {
      systemPrompt: repair
        ? `${DEVELOPER_SYSTEM_PROMPT}\n\n上一次响应未返回可执行 JSON action。请只在 assistant content 中返回完整 JSON，禁止仅输出 reasoning_content 或工具参数。`
        : DEVELOPER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input }],
      temperature: 0,
      responseFormat: "json_object"
    }, signal);
    const first = await request(false);
    const parsed = parseJsonModelResponse({
      agentName: "Developer",
      content: first.message.content,
      reasoningContent: first.message.reasoningContent
    });
    if (parsed.source === "content" || hasActionType(parsed.value)) return parsed.value;

    const repaired = await request(true);
    const repairedParsed = parseJsonModelResponse({
      agentName: "Developer",
      content: repaired.message.content,
      reasoningContent: repaired.message.reasoningContent
    });
    if (!hasActionType(repairedParsed.value)) {
      throw new Error("Developer Agent 响应协议错误：模型未返回包含 type 字段的完整 action JSON，已自动重试 1 次。");
    }
    return repairedParsed.value;
  }
}
