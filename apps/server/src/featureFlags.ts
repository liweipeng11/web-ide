export type FeatureFlags = {
  contextBudgetV2: boolean;
  modelProviderGateway: boolean;
  lsp: boolean;
  inlineEdit: boolean;
};

export type FeatureImplementations = Record<keyof FeatureFlags, boolean>;
export type FeaturePath = "legacy" | "next";
export type FeatureCapability = { enabled: boolean; available: boolean; active: boolean; path: FeaturePath };

const featureFlagEnvironmentNames: Record<keyof FeatureFlags, string> = {
  contextBudgetV2: "CONTEXT_BUDGET_V2_ENABLED",
  modelProviderGateway: "MODEL_PROVIDER_GATEWAY_ENABLED",
  lsp: "LSP_ENABLED",
  inlineEdit: "INLINE_EDIT_ENABLED"
};

function parseBoolean(value: string | undefined) {
  if (!value?.trim()) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

// 所有新能力默认关闭，保证部署后仍走原有稳定路径。
export function readFeatureFlags(environment: NodeJS.ProcessEnv = process.env): FeatureFlags {
  return Object.fromEntries(Object.entries(featureFlagEnvironmentNames).map(([key, name]) => [key, parseBoolean(environment[name])])) as FeatureFlags;
}

export type ServerCapabilities = {
  version: 1;
  features: Record<keyof FeatureFlags, FeatureCapability>;
  models: {
    selection: boolean;
    configured: boolean;
    defaultModel: string;
    catalogEndpoint?: string;
  };
};

export function selectFeaturePath<T>(enabled: boolean, implementationAvailable: boolean, nextPath: () => T, legacyPath: () => T): T {
  return enabled && implementationAvailable ? nextPath() : legacyPath();
}

export function resolveFeaturePath(name: keyof FeatureFlags, flags: FeatureFlags, implementations: FeatureImplementations): FeaturePath {
  return selectFeaturePath(flags[name], implementations[name], () => "next", () => "legacy");
}

export function createServerCapabilities(input: { flags: FeatureFlags; implementations: FeatureImplementations; aiConfigured: boolean; defaultModel: string }): ServerCapabilities {
  const features = Object.fromEntries(
    (Object.keys(input.flags) as Array<keyof FeatureFlags>).map((name) => {
      const path = resolveFeaturePath(name, input.flags, input.implementations);
      return [name, { enabled: input.flags[name], available: input.implementations[name], active: path === "next", path }];
    })
  ) as Record<keyof FeatureFlags, FeatureCapability>;

  return {
    version: 1,
    features,
    models: {
      selection: features.modelProviderGateway.active,
      configured: input.aiConfigured,
      defaultModel: input.defaultModel,
      catalogEndpoint: features.modelProviderGateway.active ? "/api/models" : undefined
    }
  };
}

// 只有已完成并通过回退测试的能力才标记可用，避免 Capability 提前误报。
export const implementedFeatures: FeatureImplementations = {
  contextBudgetV2: true,
  modelProviderGateway: true,
  lsp: true,
  inlineEdit: true
};
