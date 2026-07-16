import type { FileChatStreamEvent, TaskSession } from "./api.js";

type ContextBudgetEventData = Extract<FileChatStreamEvent, { event: "context_budget" }>["data"];

/**
 * 将服务端上下文快照精确合并到目标任务。
 * `summary: null` 表示服务端已明确清空摘要，不能继续沿用旧的待审批状态。
 */
export function mergeContextBudgetSession(session: TaskSession, event: ContextBudgetEventData): TaskSession {
  if (session.id !== event.taskSessionId) return session;

  return {
    ...session,
    contextBudgetSnapshot: event.snapshot,
    contextSummary: event.summary ?? undefined
  };
}
