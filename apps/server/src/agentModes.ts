import { commandAgentToolDefinitions } from "./agentCommandTools.js";
import { fileEditToolDefinitions } from "./fileEditTools.js";
import { patchAgentToolDefinitions } from "./agentPatchTools.js";
import { createAgentToolRegistry, type AgentToolRegistry } from "./agentToolRegistry.js";
import { readonlyAgentToolDefinitions } from "./agentTools.js";
import { AI_AGENT_ACT_SYSTEM_PROMPT, AI_AGENT_PLAN_SYSTEM_PROMPT } from "./prompts.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";

export type AgentMode = "plan" | "act";

export type AgentModeConfig = {
  mode: AgentMode;
  label: string;
  systemPrompt: string;
  registry: AgentToolRegistry;
  canModifyWorkspace: boolean;
};

const actToolDefinitions: AgentToolDefinition[] = [
  ...readonlyAgentToolDefinitions,
  // Act 模式优先暴露直接编辑工具，同时保留旧 patch 工具作为明确待审补丁或兜底链路。
  ...fileEditToolDefinitions,
  ...patchAgentToolDefinitions,
  ...commandAgentToolDefinitions
];

const modeConfigs: Record<AgentMode, AgentModeConfig> = {
  plan: {
    mode: "plan",
    label: "Plan",
    systemPrompt: AI_AGENT_PLAN_SYSTEM_PROMPT,
    registry: createAgentToolRegistry(readonlyAgentToolDefinitions),
    canModifyWorkspace: false
  },
  act: {
    mode: "act",
    label: "Act",
    systemPrompt: AI_AGENT_ACT_SYSTEM_PROMPT,
    registry: createAgentToolRegistry(actToolDefinitions),
    canModifyWorkspace: true
  }
};

export function isAgentMode(value: unknown): value is AgentMode {
  return value === "plan" || value === "act";
}

export function normalizeAgentMode(value: unknown, fallback: AgentMode = "act"): AgentMode {
  return isAgentMode(value) ? value : fallback;
}

/**
 * 统一解析智能体模式，确保 Plan 模式永远只暴露只读工具，Act 模式才允许编辑、补丁和命令工具。
 */
export function getAgentModeConfig(mode: AgentMode = "act"): AgentModeConfig {
  return modeConfigs[mode];
}
