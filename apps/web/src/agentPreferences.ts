import type { AgentMode } from "./api";

export type AgentPreferences = {
  defaultMode: AgentMode;
};

const AGENT_PREFERENCES_KEY = "mini-ai-web-editor:agent-preferences";
const fallbackPreferences: AgentPreferences = { defaultMode: "act" };

/** 读取只影响当前浏览器的智能体交互偏好，损坏数据会自动回退。 */
export function readAgentPreferences(): AgentPreferences {
  if (typeof window === "undefined") return fallbackPreferences;

  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_PREFERENCES_KEY) || "{}") as Partial<AgentPreferences>;
    return { defaultMode: parsed.defaultMode === "plan" ? "plan" : "act" };
  } catch {
    return fallbackPreferences;
  }
}

export function writeAgentPreferences(preferences: AgentPreferences) {
  try {
    window.localStorage.setItem(AGENT_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch {
    // 浏览器禁用本地存储时仍允许保存服务端模型默认值，模式偏好仅在当前会话生效。
  }
}
