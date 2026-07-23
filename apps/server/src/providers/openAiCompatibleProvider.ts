import { config } from "../config.js";
import { adaptOpenAiCompletionResponse, toOpenAiChatCompletionBody } from "../contracts/openAiCompatibility.js";
import type { ModelDescriptor, ModelEvent, ModelRequest, ModelResponse, ProviderHealth } from "../contracts/model.js";
import { HttpError } from "../errors.js";
import { requestChatCompletion, requestChatCompletionStream, type OpenAiCompatibleStreamChunk } from "../aiHttp.js";
import type { AgentCompletionResponse } from "../agentToolTypes.js";
import { ProviderError, type ModelProvider } from "./types.js";

const SAFE_TOOL_NAME_NORMALIZATION = new Set([
  "inspectProject",
  "listFiles",
  "listCodeDefinitionNames",
  "searchFilesByName",
  "searchCode",
  "searchCodeRegex",
  "readFile",
  "readFileChunk",
  "readFileRange"
]);
const SPECIAL_CHANNEL_MARKER = /<\|[^<>|]+\|>/;

function getAdvertisedToolNames(tools: unknown[] | undefined) {
  const names = new Set<string>();

  for (const tool of tools || []) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const fn = (tool as { function?: unknown }).function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) names.add(name.trim());
  }

  return names;
}

function normalizeProviderToolName(rawName: string, advertisedToolNames: Set<string>) {
  if (advertisedToolNames.has(rawName)) return rawName;

  const marker = SPECIAL_CHANNEL_MARKER.exec(rawName);
  if (!marker) return null;

  // 只允许剥离模型误拼接的特殊通道后缀，不做大小写、前缀或编辑距离模糊匹配。
  const candidate = rawName.slice(0, marker.index);
  const suffix = rawName.slice(marker.index);
  const hasSingleMarker = suffix.match(new RegExp(SPECIAL_CHANNEL_MARKER.source, "g"))?.length === 1;
  const safeSuffix = /^<\|[^<>|]+\|>[a-z_]+$/i.test(suffix);
  if (!hasSingleMarker || !safeSuffix || !SAFE_TOOL_NAME_NORMALIZATION.has(candidate)) return null;

  return advertisedToolNames.has(candidate) ? candidate : null;
}

function normalizeResponseToolNames(response: ModelResponse, request: ModelRequest) {
  const toolCalls = response.message.toolCalls;
  if (!toolCalls?.length) return response;

  const advertisedToolNames = getAdvertisedToolNames(request.tools);
  const normalizedToolCalls = toolCalls.map((toolCall) => {
    const normalizedName = normalizeProviderToolName(toolCall.name, advertisedToolNames);
    if (!normalizedName) {
      throw new ProviderError("invalid_tool_name", `模型 Provider 返回了未注册或不安全的工具名：${toolCall.name}`, false);
    }
    return normalizedName === toolCall.name ? toolCall : { ...toolCall, name: normalizedName };
  });

  return { ...response, message: { ...response.message, toolCalls: normalizedToolCalls } };
}

function mapProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof SyntaxError) return new ProviderError("invalid_response", "模型 Provider 返回了无效响应", false);
  if (error instanceof Error && error.name === "AbortError") return new ProviderError("cancelled", "模型请求已取消", false);
  if (error instanceof Error && /response did not include|invalid response/i.test(error.message)) return new ProviderError("invalid_response", "模型 Provider 返回了无效响应", false);
  if (error instanceof Error && /timeout|timed out|etimedout|connect_timeout/i.test(error.message)) return new ProviderError("timeout", "模型 Provider 请求超时", true);
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return new ProviderError("authentication", "模型 Provider 认证失败", false, error.status);
    if (error.status === 429) return new ProviderError("rate_limit", "模型 Provider 请求过于频繁", true, error.status);
    if (error.status >= 500) return new ProviderError("unavailable", "模型 Provider 暂时不可用", true, error.status);
    return new ProviderError("invalid_response", error.message, false, error.status);
  }
  return new ProviderError("unknown", error instanceof Error ? error.message : "模型 Provider 请求失败", false);
}

export type OpenAiCompatibleRuntimeConfig = {
  id: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
};

function createDescriptor(modelId: string, providerId: string): ModelDescriptor {
  const metadata = config.aiModelCatalog.find((entry) => entry.id === modelId);
  const capabilities = metadata?.capabilities && typeof metadata.capabilities === "object" && !Array.isArray(metadata.capabilities)
    ? metadata.capabilities as Record<string, unknown>
    : {};
  const price = metadata?.price && typeof metadata.price === "object" && !Array.isArray(metadata.price)
    ? metadata.price as Record<string, unknown>
    : {};
  const numberValue = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const optionalNumber = (value: unknown, fallback?: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  const booleanValue = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;
  return {
    id: modelId,
    providerId,
    displayName: typeof metadata?.displayName === "string" && metadata.displayName.trim() ? metadata.displayName.trim() : modelId,
    capabilities: {
      contextWindowTokens: numberValue(capabilities.contextWindowTokens, config.aiContextWindowTokens),
      maxOutputTokens: numberValue(capabilities.maxOutputTokens, config.aiMaxOutputTokens),
      toolCalling: booleanValue(capabilities.toolCalling, true),
      parallelToolCalling: booleanValue(capabilities.parallelToolCalling, true),
      imageInput: booleanValue(capabilities.imageInput, false),
      reasoningEffort: booleanValue(capabilities.reasoningEffort, false),
      promptCache: booleanValue(capabilities.promptCache, false)
    },
    price: {
      currency: "USD",
      inputPerMillionTokens: optionalNumber(price.inputPerMillionTokens, config.aiInputPricePerMillionTokens),
      outputPerMillionTokens: optionalNumber(price.outputPerMillionTokens, config.aiOutputPricePerMillionTokens),
      cachedInputPerMillionTokens: optionalNumber(price.cachedInputPerMillionTokens, config.aiCachedInputPricePerMillionTokens)
    },
    recommendedFor: Array.isArray(metadata?.recommendedFor) ? metadata.recommendedFor.filter((value): value is string => typeof value === "string") : ["chat", "plan", "act"],
    disabledReason: typeof metadata?.disabledReason === "string" && metadata.disabledReason.trim() ? metadata.disabledReason.trim() : undefined
  };
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id: string;

  constructor(private readonly runtimeConfig?: OpenAiCompatibleRuntimeConfig) {
    this.id = runtimeConfig?.id || "openai-compatible";
  }

  private get runtime(): OpenAiCompatibleRuntimeConfig {
    return this.runtimeConfig || {
      id: "openai-compatible",
      baseUrl: config.aiBaseUrl,
      apiKey: config.aiApiKey,
      models: config.aiModels
    };
  }

  async listModels() {
    return this.runtime.models.map((modelId) => createDescriptor(modelId, this.id));
  }

  async validateConfig(): Promise<ProviderHealth> {
    return this.runtime.apiKey
      ? { configured: true, available: true }
      : { configured: false, available: false, message: "未配置 AI_API_KEY" };
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (signal?.aborted) throw new ProviderError("cancelled", "模型请求已取消", false);
    try {
      const response = await requestChatCompletion(toOpenAiChatCompletionBody(request), signal, this.runtime) as AgentCompletionResponse;
      return normalizeResponseToolNames(adaptOpenAiCompletionResponse(response), request);
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const events: ModelEvent[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    const toolCalls = new Map<number, { id: string; name: string; rawArguments: string }>();
    const advertisedToolNames = getAdvertisedToolNames(request.tools);
    let finishReason: string | undefined;
    const push = (event: ModelEvent) => { events.push(event); wake?.(); wake = null; };

    const handleChunk = (chunk: OpenAiCompatibleStreamChunk) => {
      const choice = chunk.choices?.[0];
      if (choice?.delta?.reasoning_content) push({ type: "reasoning_summary", summary: choice.delta.reasoning_content });
      for (const delta of choice?.delta?.tool_calls || []) {
        const index = delta.index ?? 0;
        const current = toolCalls.get(index) || { id: delta.id || `tool-${index}`, name: delta.function?.name || "", rawArguments: "" };
        if (delta.id) current.id = delta.id;
        if (delta.function?.name) current.name = delta.function.name;
        if (delta.function?.arguments) {
          current.rawArguments += delta.function.arguments;
        }
        toolCalls.set(index, current);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        push({
          type: "usage",
          usage: {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
          }
        });
      }
    };

    const body = { ...toOpenAiChatCompletionBody(request), stream: true, stream_options: { include_usage: true } };
    void requestChatCompletionStream(body, (delta) => push({ type: "text_delta", delta }), signal, handleChunk, this.runtime)
      .then((answer) => {
        for (const current of toolCalls.values()) {
          const normalizedName = normalizeProviderToolName(current.name, advertisedToolNames);
          if (!normalizedName) {
            push({
              type: "error",
              code: "invalid_tool_name",
              message: `模型 Provider 返回了未注册或不安全的工具名：${current.name}`,
              retryable: false
            });
            continue;
          }
          let argumentsValue: Record<string, unknown> = {};
          try { argumentsValue = JSON.parse(current.rawArguments) as Record<string, unknown>; } catch { /* 无效参数交给上层统一校验。 */ }
          // 名称完整后再发出工具事件，避免消费者提前看到未经白名单校验的流式片段。
          push({ type: "tool_call_start", call: { id: current.id, name: normalizedName } });
          if (current.rawArguments) push({ type: "tool_call_arguments_delta", id: current.id, delta: current.rawArguments });
          push({ type: "tool_call_end", call: { id: current.id, name: normalizedName, arguments: argumentsValue, rawArguments: current.rawArguments } });
        }
        push({ type: "done", finishReason: signal?.aborted ? "cancelled" : finishReason || (answer ? "stop" : "empty") });
      })
      .catch((error) => {
        const mapped = mapProviderError(error);
        push({ type: "error", code: mapped.code, message: mapped.message, retryable: mapped.retryable });
      })
      .finally(() => { finished = true; wake?.(); wake = null; });

    while (!finished || events.length) {
      if (!events.length) await new Promise<void>((resolve) => { wake = resolve; });
      while (events.length) yield events.shift()!;
    }
  }
}
