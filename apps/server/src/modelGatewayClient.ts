import { config } from "./config.js";
import { fromOpenAiChatCompletionBody } from "./contracts/openAiCompatibility.js";
import type { ModelEvent, ModelResponse, ModelSelection, ModelUsage } from "./contracts/model.js";
import {
  requestChatCompletion as requestLegacyCompletion,
  requestChatCompletionStream as requestLegacyStream,
  requestChatCompletionWithToolChoiceFallback as requestLegacyToolFallback,
  requestJsonChatCompletion as requestLegacyJson,
  requestJsonChatCompletionWithToolChoiceFallback as requestLegacyJsonToolFallback
} from "./aiHttp.js";
import { getModelExecutionContext } from "./modelExecutionContext.js";
import { RunMetricsTracker, classifyRunFailure } from "./observability/index.js";
import { ProviderError, providerGateway } from "./providers/index.js";

export type GatewayCompatibleCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      role?: "assistant";
      content?: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
};

function selectionFor(body: Record<string, unknown>): ModelSelection {
  return getModelExecutionContext()?.selection || {
    providerId: "openai-compatible",
    modelId: typeof body.model === "string" && body.model ? body.model : config.aiModel
  };
}

function toCompatibleResponse(response: ModelResponse): GatewayCompatibleCompletionResponse {
  return {
    choices: [{
      finish_reason: response.finishReason,
      message: {
        role: "assistant",
        content: response.message.content ?? null,
        tool_calls: response.message.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.rawArguments ?? JSON.stringify(call.arguments) }
        }))
      }
    }],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      prompt_tokens_details: { cached_tokens: response.usage.cachedInputTokens },
      completion_tokens_details: { reasoning_tokens: response.usage.reasoningTokens }
    }
  };
}

async function createMetrics(selection: ModelSelection) {
  const context = getModelExecutionContext();
  if (!context?.taskSessionId) return null;
  const tracker = new RunMetricsTracker({
    runId: `gateway-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    taskSessionId: context.taskSessionId,
    provider: selection.providerId,
    model: selection.modelId,
    mode: context.mode
  });
  tracker.setPrice((await providerGateway.getModel(selection)).price);
  return tracker;
}

export async function requestChatCompletion(body: Record<string, unknown>, signal?: AbortSignal): Promise<GatewayCompatibleCompletionResponse> {
  if (!config.featureFlags.modelProviderGateway) return requestLegacyCompletion(body, signal);
  const selection = selectionFor(body);
  const request = fromOpenAiChatCompletionBody({ ...body, model: selection.modelId });
  const tracker = await createMetrics(selection);
  const startedAt = Date.now();
  try {
    const response = await providerGateway.complete(selection, {
      messages: request.messages,
      temperature: request.temperature,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat
    }, signal);
    tracker?.recordFirstTokenLatency(response.firstTokenLatencyMs ?? Date.now() - startedAt, response.firstTokenLatencyMs === undefined ? "completion_upper_bound" : "provider");
    tracker?.addUsage(response.usage);
    await tracker?.finish({ status: "completed" });
    return toCompatibleResponse(response);
  } catch (error) {
    await tracker?.finish({ status: error instanceof ProviderError && error.code === "cancelled" ? "cancelled" : "failed", failureCategory: classifyRunFailure(error) });
    throw error;
  }
}

function isCompatibilityError(error: unknown) {
  return error instanceof ProviderError && (error.status === 400 || error.status === 422 || error.status === 500 || error.code === "invalid_response");
}

export async function requestJsonChatCompletion(body: Record<string, unknown>) {
  if (!config.featureFlags.modelProviderGateway) return requestLegacyJson(body);
  try {
    return await requestChatCompletion({ ...body, response_format: { type: "json_object" } });
  } catch (error) {
    if (isCompatibilityError(error)) return requestChatCompletion(body);
    throw error;
  }
}

export async function requestChatCompletionWithToolChoiceFallback(body: Record<string, unknown>, fallbackBody: Record<string, unknown>, runId: string) {
  if (!config.featureFlags.modelProviderGateway) return requestLegacyToolFallback(body, fallbackBody, runId);
  try {
    return await requestChatCompletion(body);
  } catch (error) {
    if (!isCompatibilityError(error)) throw error;
    try { return await requestChatCompletion(fallbackBody); }
    catch (fallbackError) {
      if (!isCompatibilityError(fallbackError)) throw fallbackError;
      const finalBody = { ...fallbackBody };
      delete finalBody.tool_choice;
      return requestChatCompletion(finalBody);
    }
  }
}

export async function requestJsonChatCompletionWithToolChoiceFallback(body: Record<string, unknown>, fallbackBody: Record<string, unknown>, runId: string) {
  if (!config.featureFlags.modelProviderGateway) return requestLegacyJsonToolFallback(body, fallbackBody, runId);
  try {
    return await requestJsonChatCompletion(body);
  } catch (error) {
    if (!isCompatibilityError(error)) throw error;
    return requestJsonChatCompletion(fallbackBody);
  }
}

export async function requestChatCompletionStream(body: Record<string, unknown>, onDelta: (delta: string) => void, signal?: AbortSignal) {
  if (!config.featureFlags.modelProviderGateway) return requestLegacyStream(body, onDelta, signal);
  const selection = selectionFor(body);
  const request = fromOpenAiChatCompletionBody({ ...body, model: selection.modelId });
  const tracker = await createMetrics(selection);
  const usage: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  let answer = "";
  const startedAt = Date.now();
  let firstEventRecorded = false;
  try {
    for await (const event of providerGateway.stream(selection, {
      messages: request.messages,
      temperature: request.temperature,
      tools: request.tools,
      toolChoice: request.toolChoice,
      responseFormat: request.responseFormat
    }, signal)) {
      if (!firstEventRecorded && (event.type === "text_delta" || event.type === "tool_call_start" || event.type === "reasoning_summary")) {
        tracker?.recordFirstTokenLatency(Date.now() - startedAt, "provider");
        firstEventRecorded = true;
      }
      if (event.type === "text_delta") { answer += event.delta; onDelta(event.delta); }
      if (event.type === "usage") Object.assign(usage, event.usage);
      if (event.type === "error") throw new ProviderError(event.code as ProviderError["code"], event.message, event.retryable);
    }
    if (!firstEventRecorded) tracker?.recordFirstTokenLatency(Date.now() - startedAt, "completion_upper_bound");
    tracker?.addUsage(usage);
    await tracker?.finish({ status: signal?.aborted ? "cancelled" : "completed" });
    return answer;
  } catch (error) {
    await tracker?.finish({ status: signal?.aborted ? "cancelled" : "failed", failureCategory: classifyRunFailure(error) });
    throw error;
  }
}
