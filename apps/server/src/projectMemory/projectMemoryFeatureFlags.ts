export type ProjectMemoryFeatureFlags = {
  v3Enabled: boolean;
  autoExtractionEnabled: boolean;
  retrievalEnabled: boolean;
  validationEnabled: boolean;
  usageLogEnabled: boolean;
};

const environmentNames: Record<keyof ProjectMemoryFeatureFlags, string> = {
  v3Enabled: "PROJECT_MEMORY_V3_ENABLED",
  autoExtractionEnabled: "PROJECT_MEMORY_AUTO_EXTRACTION_ENABLED",
  retrievalEnabled: "PROJECT_MEMORY_RETRIEVAL_ENABLED",
  validationEnabled: "PROJECT_MEMORY_VALIDATION_ENABLED",
  usageLogEnabled: "PROJECT_MEMORY_USAGE_LOG_ENABLED"
};

export const defaultProjectMemoryFeatureFlags: ProjectMemoryFeatureFlags = {
  v3Enabled: true,
  autoExtractionEnabled: true,
  retrievalEnabled: true,
  validationEnabled: true,
  usageLogEnabled: true
};

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** 每次读取调用方传入的环境，便于灰度配置测试且避免模块加载顺序影响。 */
export function readProjectMemoryFeatureFlags(environment: NodeJS.ProcessEnv = process.env): ProjectMemoryFeatureFlags {
  return Object.fromEntries(
    (Object.entries(environmentNames) as Array<[keyof ProjectMemoryFeatureFlags, string]>).map(([key, name]) => [
      key,
      parseBoolean(environment[name], defaultProjectMemoryFeatureFlags[key])
    ])
  ) as ProjectMemoryFeatureFlags;
}

/** V3 总开关优先级最高，关闭后所有增强链路都必须回到无 Memory 注入状态。 */
export function isProjectMemoryFeatureEnabled(
  feature: Exclude<keyof ProjectMemoryFeatureFlags, "v3Enabled">,
  flags = readProjectMemoryFeatureFlags()
) {
  return flags.v3Enabled && flags[feature];
}
