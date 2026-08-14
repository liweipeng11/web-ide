export type ReadOnlyRuntimeMode = "off" | "shadow" | "internal";

export type ReadOnlyRuntimeRolloutConfig = {
  mode: ReadOnlyRuntimeMode;
};

const READ_ONLY_RUNTIME_MODES = new Set<ReadOnlyRuntimeMode>(["off", "shadow", "internal"]);

/** 未配置或非法配置一律关闭，避免迁移中的只读路径意外接管生产结果。 */
export function readReadOnlyRuntimeRollout(environment: NodeJS.ProcessEnv = process.env): ReadOnlyRuntimeRolloutConfig {
  const value = environment.AGENT_LANGGRAPH_READ_ONLY_MODE?.trim().toLowerCase() as ReadOnlyRuntimeMode | undefined;
  return { mode: value && READ_ONLY_RUNTIME_MODES.has(value) ? value : "off" };
}
