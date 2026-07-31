import { commandAgentToolDefinitions } from "./agentCommandTools.js";
import { fileEditToolDefinitions } from "./fileEditTools.js";
import { patchAgentToolDefinitions } from "./agentPatchTools.js";
import { createAgentToolRegistry, type AgentToolRegistry } from "./agentToolRegistry.js";
import { readonlyAgentToolDefinitions } from "./agentTools.js";
import { AI_AGENT_ACT_SYSTEM_PROMPT, AI_AGENT_PLAN_SYSTEM_PROMPT } from "./prompts.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import { externalBrowserAgentToolDefinitions } from "./externalContext/index.js";
import { completionAgentToolDefinitions } from "./agentCompletionTools.js";

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
  ...externalBrowserAgentToolDefinitions,
  // Act 模式优先暴露 patch 工具，让常规修改先进入 diff 审核；直接编辑工具保留为兜底能力。
  ...patchAgentToolDefinitions,
  ...fileEditToolDefinitions,
  ...commandAgentToolDefinitions,
  ...completionAgentToolDefinitions
];

// 文件计划会更新 Agent 上下文和任务会话，因此 Plan 模式不应暴露该工具。
const planToolDefinitions = [
  ...readonlyAgentToolDefinitions.filter((definition) => definition.name !== "planFileChanges"),
  ...completionAgentToolDefinitions
];

const modeConfigs: Record<AgentMode, AgentModeConfig> = {
  plan: {
    mode: "plan",
    label: "Plan",
    systemPrompt: AI_AGENT_PLAN_SYSTEM_PROMPT,
    registry: createAgentToolRegistry(planToolDefinitions),
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
