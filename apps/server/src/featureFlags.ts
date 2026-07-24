export type FeatureFlags = {
  contextBudgetV2: boolean;
  modelProviderGateway: boolean;
  lsp: boolean;
  inlineEdit: boolean;
  commandExecutionV2: boolean;
  plannedFileResolution: boolean;
  semanticCompletionCheck: boolean;
};

export type FeatureImplementations = Record<keyof FeatureFlags, boolean>;
export type FeaturePath = "legacy" | "next";
export type FeatureCapability = { enabled: boolean; available: boolean; active: boolean; path: FeaturePath };

const featureFlagEnvironmentNames: Record<keyof FeatureFlags, string> = {
  contextBudgetV2: "CONTEXT_BUDGET_V2_ENABLED",
  modelProviderGateway: "MODEL_PROVIDER_GATEWAY_ENABLED",
  lsp: "LSP_ENABLED",
  inlineEdit: "INLINE_EDIT_ENABLED",
  commandExecutionV2: "COMMAND_EXECUTION_V2_ENABLED",
  plannedFileResolution: "AGENT_PLANNED_FILE_RESOLUTION",
  semanticCompletionCheck: "AGENT_SEMANTIC_COMPLETION_CHECK"
};

export const defaultFeatureFlags: FeatureFlags = {
  contextBudgetV2: true,
  modelProviderGateway: true,
  lsp: true,
  inlineEdit: true,
  commandExecutionV2: true,
  plannedFileResolution: true,
  semanticCompletionCheck: true
};

export type FeatureDecisionDifference = {
  feature: "plannedFileResolution" | "semanticCompletionCheck";
  legacyDecision: unknown;
  nextDecision: unknown;
};

/**
 * 灰度期间只记录脱敏后的新旧决策，不记录源码、Prompt 或文件内容。
 * 调用方仍由 Feature Flag 决定实际采用哪条路径。
 */
export function recordFeatureDecisionDifference(
  difference: FeatureDecisionDifference,
  logger: (message: string) => void = console.info
) {
  if (JSON.stringify(difference.legacyDecision) === JSON.stringify(difference.nextDecision)) {
    return false;
  }

  logger(`[agent-feature-shadow] ${JSON.stringify(difference)}`);
  return true;
}

function parseBoolean(value: string | undefined, defaultValue: boolean) {
  if (!value?.trim()) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

// 阶段 5 默认启用已完成验收的能力，同时保留环境变量作为紧急回退开关。
export function readFeatureFlags(environment: NodeJS.ProcessEnv = process.env): FeatureFlags {
  return Object.fromEntries(
    (Object.entries(featureFlagEnvironmentNames) as Array<[keyof FeatureFlags, string]>).map(([key, name]) => [key, parseBoolean(environment[name], defaultFeatureFlags[key])])
  ) as FeatureFlags;
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
  inlineEdit: true,
  commandExecutionV2: true,
  plannedFileResolution: true,
  semanticCompletionCheck: true
};
