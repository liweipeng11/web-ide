import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { ProviderGateway } from "./providerGateway.js";

export * from "./types.js";
export * from "./providerGateway.js";
export * from "./openAiCompatibleProvider.js";

export const providerGateway = new ProviderGateway([new OpenAiCompatibleProvider()]);
