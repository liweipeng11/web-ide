export type ReadOnlyRuntimeMode = "off" | "shadow" | "internal" | "10" | "50" | "all";
export type WriteRuntimeMode = ReadOnlyRuntimeMode;

export type ReadOnlyRuntimeRolloutConfig = {
  mode: ReadOnlyRuntimeMode;
};

export type WriteRuntimeRolloutConfig = {
  mode: WriteRuntimeMode;
};

const READ_ONLY_RUNTIME_MODES = new Set<ReadOnlyRuntimeMode>(["off", "shadow", "internal", "10", "50", "all"]);

/** 未配置或非法配置一律关闭，避免迁移中的只读路径意外接管生产结果。 */
export function readReadOnlyRuntimeRollout(environment: NodeJS.ProcessEnv = process.env): ReadOnlyRuntimeRolloutConfig {
  const value = environment.AGENT_LANGGRAPH_READ_ONLY_MODE?.trim().toLowerCase() as ReadOnlyRuntimeMode | undefined;
  return { mode: value && READ_ONLY_RUNTIME_MODES.has(value) ? value : "off" };
}

/**
 * 写路径仍受 AGENT_LANGGRAPH_RUNTIME_ENABLED 总开关保护。
 * 未配置细分模式时保持原总开关语义；非法配置则安全关闭写路径接管。
 */
export function readWriteRuntimeRollout(environment: NodeJS.ProcessEnv = process.env): WriteRuntimeRolloutConfig {
  const raw = environment.AGENT_LANGGRAPH_WRITE_MODE?.trim().toLowerCase();
  if (!raw) return { mode: "all" };
  return { mode: READ_ONLY_RUNTIME_MODES.has(raw as WriteRuntimeMode) ? raw as WriteRuntimeMode : "off" };
}
