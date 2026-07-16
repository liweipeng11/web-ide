import type { ModelDescriptor, ModelEvent, ModelRequest, ModelResponse, ProviderHealth } from "../contracts/model.js";

/** Provider 统一边界，业务代码不得依赖供应商私有响应结构。 */
export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
  validateConfig(): Promise<ProviderHealth>;
}

export type ProviderErrorCode = "authentication" | "rate_limit" | "timeout" | "unavailable" | "invalid_response" | "cancelled" | "unknown";

export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string, public readonly retryable: boolean, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}
