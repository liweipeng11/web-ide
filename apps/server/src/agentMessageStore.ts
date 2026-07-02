import {
  appendTaskSessionAgentMessage,
  clearTaskSessionPendingToolCall,
  getTaskSession,
  setTaskSessionPendingToolCall
} from "./taskSessionStore.js";
import type { AgentMessage, PendingAgentToolCall } from "./types.js";

export type AgentMessageDraft = Omit<AgentMessage, "id" | "createdAt"> & Partial<Pick<AgentMessage, "id" | "createdAt">>;
export type PendingToolCallDraft = Omit<PendingAgentToolCall, "status" | "createdAt"> & Partial<Pick<PendingAgentToolCall, "createdAt">>;

export async function listAgentMessages(taskSessionId: string) {
  const session = await getTaskSession(taskSessionId);

  // 连续 Agent 恢复时只需要消息链本身，调用方不应依赖 TaskSession 的完整结构。
  return session.agentMessages || [];
}

export async function appendAgentMessage(taskSessionId: string | null | undefined, message: AgentMessageDraft) {
  return appendTaskSessionAgentMessage(taskSessionId, message);
}

export async function getPendingAgentToolCall(taskSessionId: string) {
  const session = await getTaskSession(taskSessionId);

  return session.pendingToolCall || null;
}

export async function setPendingAgentToolCall(taskSessionId: string | null | undefined, input: PendingToolCallDraft) {
  // 工具调用进入 pending 后，任务会话会切换到 awaiting_approval，便于前端恢复执行入口。
  return setTaskSessionPendingToolCall(taskSessionId, input);
}

export async function clearPendingAgentToolCall(taskSessionId: string | null | undefined, actionId?: string) {
  return clearTaskSessionPendingToolCall(taskSessionId, actionId);
}
