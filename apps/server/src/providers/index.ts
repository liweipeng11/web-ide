import { OpenAiCompatibleProvider, type OpenAiCompatibleRuntimeConfig } from "./openAiCompatibleProvider.js";
import { ProviderGateway } from "./providerGateway.js";

export * from "./types.js";
export * from "./providerGateway.js";
export * from "./openAiCompatibleProvider.js";

export const providerGateway = new ProviderGateway([new OpenAiCompatibleProvider()]);

export function configureProviderGateway(configs: OpenAiCompatibleRuntimeConfig[]) {
  providerGateway.replaceProviders(configs.map((providerConfig) => new OpenAiCompatibleProvider(providerConfig)));
}
