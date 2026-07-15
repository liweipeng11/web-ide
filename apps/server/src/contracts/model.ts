export type ModelProviderConfig = {
  id: string;
  type: string;
  baseUrl?: string;
  configured: boolean;
};

export type ModelCapabilities = {
  contextWindowTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  parallelToolCalling: boolean;
  imageInput: boolean;
  reasoningEffort: boolean;
  promptCache: boolean;
};

export type ModelDescriptor = {
  id: string;
  providerId: string;
  displayName: string;
  capabilities: ModelCapabilities;
  recommendedFor?: string[];
  disabledReason?: string;
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
};

export type ModelMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
};

export type ModelRequest = {
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  tools?: unknown[];
  toolChoice?: "auto" | "none" | "required";
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
};

export type ModelResponse = {
  message: ModelMessage;
  usage: ModelUsage;
  finishReason?: string;
  // 流式 Provider 可返回精确首 token 延迟；非流式兼容层由 Runtime 记录完成耗时上界。
  firstTokenLatencyMs?: number;
};

export type ModelEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; call: Pick<ModelToolCall, "id" | "name"> }
  | { type: "tool_call_arguments_delta"; id: string; delta: string }
  | { type: "tool_call_end"; call: ModelToolCall }
  | { type: "reasoning_summary"; summary: string }
  | { type: "usage"; usage: ModelUsage }
  | { type: "error"; code: string; message: string; retryable: boolean }
  | { type: "done"; finishReason?: string };
