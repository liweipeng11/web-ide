import type { ModelDescriptor, ModelEvent, ModelRequest, ModelResponse, ModelSelection } from "../contracts/model.js";
import { ProviderError, type ModelProvider } from "./types.js";

/** Provider 注册、模型查找和能力校验统一由 Gateway 负责。 */
export class ProviderGateway {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(providers: ModelProvider[]) {
    providers.forEach((provider) => this.providers.set(provider.id, provider));
  }

  replaceProviders(providers: ModelProvider[]) {
    this.providers.clear();
    providers.forEach((provider) => this.providers.set(provider.id, provider));
  }

  async listCatalog() {
    return Promise.all([...this.providers.values()].map(async (provider) => ({
      id: provider.id,
      health: await provider.validateConfig(),
      models: await provider.listModels()
    })));
  }

  async getModel(selection: ModelSelection): Promise<ModelDescriptor> {
    const provider = this.providers.get(selection.providerId);
    if (!provider) throw new ProviderError("invalid_response", `未知 Provider：${selection.providerId}`, false);
    const model = (await provider.listModels()).find((item) => item.id === selection.modelId);
    if (!model) throw new ProviderError("invalid_response", `模型不可用：${selection.modelId}`, false);
    return model;
  }

  async assertCompatible(selection: ModelSelection, mode: "chat" | "plan" | "act") {
    const provider = this.providers.get(selection.providerId);
    if (!provider) throw new ProviderError("invalid_response", `未知 Provider：${selection.providerId}`, false);
    const health = await provider.validateConfig();
    if (!health.configured || !health.available) throw new ProviderError("unavailable", health.message || `Provider ${selection.providerId} 尚未配置`, false);
    const model = await this.getModel(selection);
    if (model.disabledReason) throw new ProviderError("unavailable", model.disabledReason, false);
    if (mode === "act" && !model.capabilities.toolCalling) throw new ProviderError("invalid_response", `模型 ${model.displayName} 不支持工具调用，不能用于 Act 模式`, false);
    return model;
  }

  async complete(selection: ModelSelection, request: Omit<ModelRequest, "model">, signal?: AbortSignal): Promise<ModelResponse> {
    const provider = this.providers.get(selection.providerId);
    if (!provider) throw new ProviderError("invalid_response", `未知 Provider：${selection.providerId}`, false);
    const health = await provider.validateConfig();
    if (!health.configured || !health.available) throw new ProviderError("unavailable", health.message || `Provider ${selection.providerId} 尚未配置`, false);
    await this.getModel(selection);
    return provider.complete({ ...request, model: selection.modelId }, signal);
  }

  async *stream(selection: ModelSelection, request: Omit<ModelRequest, "model">, signal?: AbortSignal): AsyncIterable<ModelEvent> {
    const provider = this.providers.get(selection.providerId);
    if (!provider) throw new ProviderError("invalid_response", `未知 Provider：${selection.providerId}`, false);
    const health = await provider.validateConfig();
    if (!health.configured || !health.available) throw new ProviderError("unavailable", health.message || `Provider ${selection.providerId} 尚未配置`, false);
    await this.getModel(selection);
    for await (const event of provider.stream({ ...request, model: selection.modelId }, signal)) yield event;
  }
}
