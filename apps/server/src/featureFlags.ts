export type FeatureFlags = {
  contextBudgetV2: boolean;
  modelProviderGateway: boolean;
  lsp: boolean;
  inlineEdit: boolean;
  commandExecutionV2: boolean;
  plannedFileResolution: boolean;
  semanticCompletionCheck: boolean;
  safeEditEvidenceV2: boolean;
  explicitCompletionTool: boolean;
  taskRuntimeEvidencePersistence: boolean;
  completionRejectionConvergence: boolean;
  structuredCompletionRejection: boolean;
  progressiveDelivery: boolean;
  progressiveRecovery: boolean;
  unitContextBudget: boolean;
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
  semanticCompletionCheck: "AGENT_SEMANTIC_COMPLETION_CHECK",
  safeEditEvidenceV2: "SAFE_EDIT_EVIDENCE_V2_ENABLED",
  explicitCompletionTool: "AGENT_EXPLICIT_COMPLETION_TOOL",
  taskRuntimeEvidencePersistence: "AGENT_TASK_RUNTIME_EVIDENCE_PERSISTENCE",
  completionRejectionConvergence: "AGENT_COMPLETION_REJECTION_CONVERGENCE",
  structuredCompletionRejection: "AGENT_STRUCTURED_COMPLETION_REJECTION",
  progressiveDelivery: "AGENT_PROGRESSIVE_DELIVERY_ENABLED",
  progressiveRecovery: "AGENT_PROGRESSIVE_RECOVERY_ENABLED",
  unitContextBudget: "AGENT_UNIT_CONTEXT_BUDGET_ENABLED"
};

export const defaultFeatureFlags: FeatureFlags = {
  contextBudgetV2: true,
  modelProviderGateway: true,
  lsp: true,
  inlineEdit: true,
  commandExecutionV2: true,
  plannedFileResolution: true,
  semanticCompletionCheck: true,
  safeEditEvidenceV2: true,
  explicitCompletionTool: true,
  taskRuntimeEvidencePersistence: true,
  completionRejectionConvergence: true,
  structuredCompletionRejection: true,
  // 渐进交付尚未接管 Runtime，阶段 0 必须保持默认关闭以固定既有行为。
  progressiveDelivery: false,
  // 阶段 3 默认继续使用旧的无进展终止路径，按开关灰度启用分级恢复。
  progressiveRecovery: false,
  // 单元级预算编排默认关闭，可安全回退到已有的全局上下文预算。
  unitContextBudget: false
};

export type FeatureDecisionDifference = {
  feature: "plannedFileResolution" | "semanticCompletionCheck" | "safeEditEvidenceV2" | "explicitCompletionTool" | CompletionPolicyFeature;
  legacyDecision: unknown;
  nextDecision: unknown;
};

export type ExplicitCompletionRolloutMode = "shadow" | "10" | "50" | "all" | "strict";

export type CompletionPolicyFeature =
  | "taskRuntimeEvidencePersistence"
  | "completionRejectionConvergence"
  | "structuredCompletionRejection";

export type CompletionPolicyFeatureFlags = Pick<FeatureFlags, CompletionPolicyFeature>;
export type CompletionPolicyRolloutMode = "off" | "10" | "50" | "all";
export type CompletionPolicyRolloutConfig = { mode: CompletionPolicyRolloutMode };

export type ExplicitCompletionRolloutConfig = {
  mode: ExplicitCompletionRolloutMode;
};

export type ExplicitCompletionRolloutDecision = {
  mode: ExplicitCompletionRolloutMode;
  bucket: number;
  toolAvailable: boolean;
  enforceExplicitCompletion: boolean;
  compareLegacyDecision: boolean;
};

const explicitCompletionRolloutModes = new Set<ExplicitCompletionRolloutMode>(["shadow", "10", "50", "all", "strict"]);
const completionPolicyRolloutModes = new Set<CompletionPolicyRolloutMode>(["off", "10", "50", "all"]);

/** 读取任务完成策略灰度阶段；默认全量保持现有行为，非法配置则安全关闭。 */
export function readCompletionPolicyRollout(environment: NodeJS.ProcessEnv = process.env): CompletionPolicyRolloutConfig {
  const value = environment.AGENT_TASK_COMPLETION_ROLLOUT?.trim().toLowerCase() as CompletionPolicyRolloutMode | undefined;
  if (!value) return { mode: "all" };
  return { mode: completionPolicyRolloutModes.has(value) ? value : "off" };
}

/** 对三项完成策略使用同一稳定任务桶，保证审批恢复与服务重启后的路径一致。 */
export function resolveCompletionPolicyRollout(input: {
  taskKey: string;
  flags: CompletionPolicyFeatureFlags;
  config: CompletionPolicyRolloutConfig;
}): CompletionPolicyFeatureFlags {
  const threshold = input.config.mode === "10" ? 10 : input.config.mode === "50" ? 50 : input.config.mode === "all" ? 100 : 0;
  const selected = getStableRolloutBucket(input.taskKey) < threshold;
  return {
    taskRuntimeEvidencePersistence: selected && input.flags.taskRuntimeEvidencePersistence,
    completionRejectionConvergence: selected && input.flags.completionRejectionConvergence,
    structuredCompletionRejection: selected && input.flags.structuredCompletionRejection
  };
}

/** 读取显式完成协议灰度阶段；非法配置安全回退到只观测影子模式。 */
export function readExplicitCompletionRollout(environment: NodeJS.ProcessEnv = process.env): ExplicitCompletionRolloutConfig {
  const value = environment.AGENT_EXPLICIT_COMPLETION_ROLLOUT?.trim().toLowerCase() as ExplicitCompletionRolloutMode | undefined;
  return { mode: value && explicitCompletionRolloutModes.has(value) ? value : "shadow" };
}

/** 使用稳定散列固定任务分桶，确保重试、审批恢复和服务重启后仍走同一路径。 */
export function getStableRolloutBucket(taskKey: string) {
  let hash = 0x811c9dc5;
  for (const character of taskKey || "anonymous-task") {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 100;
}

export function resolveExplicitCompletionRollout(input: {
  taskKey: string;
  featureEnabled: boolean;
  implementationAvailable: boolean;
  toolRegistered: boolean;
  config: ExplicitCompletionRolloutConfig;
}): ExplicitCompletionRolloutDecision {
  const bucket = getStableRolloutBucket(input.taskKey);
  const toolAvailable = input.featureEnabled && input.implementationAvailable && input.toolRegistered;
  const threshold = input.config.mode === "10" ? 10 : input.config.mode === "50" ? 50 : input.config.mode === "all" || input.config.mode === "strict" ? 100 : 0;
  return {
    mode: input.config.mode,
    bucket,
    toolAvailable,
    enforceExplicitCompletion: toolAvailable && bucket < threshold,
    // strict 表示旧自然完成逻辑已经退出，不再承担线上对照计算。
    compareLegacyDecision: input.config.mode !== "strict"
  };
}

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

// 阶段 6 默认启用已完成验收的能力，同时保留环境变量作为紧急回退开关。
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
  semanticCompletionCheck: true,
  safeEditEvidenceV2: true,
  explicitCompletionTool: true,
  taskRuntimeEvidencePersistence: true,
  completionRejectionConvergence: true,
  structuredCompletionRejection: true,
  // 阶段 0 只有解析与观测夹具，尚未提供可切换的新执行路径。
  progressiveDelivery: false,
  progressiveRecovery: true,
  unitContextBudget: true
};
