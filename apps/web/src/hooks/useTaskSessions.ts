import type { Dispatch, SetStateAction } from "react";
import { approveTaskPlan, createTaskPlanItem, deleteTaskPlanItem, fetchTaskSession, fetchTaskSessions, rewriteTaskPlan, updateTaskPlanItem, type TaskPlanItemStatus, type TaskSession } from "../api";
import type { AppState } from "../appState";

type UseTaskSessionsOptions = {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
};

// 管理任务会话和计划项，避免聊天、文件编辑与计划逻辑交叉耦合。
export function useTaskSessions({ state, setState }: UseTaskSessionsOptions) {
  async function refreshTaskSessions(selectedTaskSessionId?: string | null) {
    if (!state.workspaceRoot) return;

    const taskHistory = await fetchTaskSessions();
    const selectedTaskSession = selectedTaskSessionId ? await fetchTaskSession(selectedTaskSessionId).then((data) => data.session).catch(() => null) : null;
    setState((current) => ({
      ...current,
      taskSessions: taskHistory.sessions,
      selectedTaskSession: selectedTaskSessionId ? selectedTaskSession : current.selectedTaskSession
    }));
  }

  // 计划项更新后同步任务列表和详情，避免两个区域显示不同版本。
  function mergeTaskSession(session: TaskSession) {
    setState((current) => ({
      ...current,
      taskSessions: [session, ...current.taskSessions.filter((item) => item.id !== session.id)].sort((left, right) => right.createdAt - left.createdAt),
      selectedTaskSession: current.selectedTaskSession?.id === session.id ? session : current.selectedTaskSession
    }));
  }

  async function handleAddPlanItem(taskSessionId: string, title: string) {
    if (!state.workspaceRoot || state.loading) return;

    try {
      const { session } = await createTaskPlanItem(taskSessionId, title);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "添加计划步骤失败" }));
    }
  }

  async function handleUpdatePlanItem(taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) {
    if (!state.workspaceRoot || state.loading) return;

    try {
      const { session } = await updateTaskPlanItem(taskSessionId, planItemId, updates);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "更新计划步骤失败" }));
    }
  }

  async function handleDeletePlanItem(taskSessionId: string, planItemId: string) {
    if (!state.workspaceRoot || state.loading) return;

    try {
      const { session } = await deleteTaskPlanItem(taskSessionId, planItemId);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "删除计划步骤失败" }));
    }
  }

  async function handleRewritePlan(taskSessionId: string, instruction: string) {
    if (!state.workspaceRoot || state.loading || !instruction.trim()) return;

    try {
      const { session } = await rewriteTaskPlan(taskSessionId, instruction);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "调整计划失败" }));
    }
  }

  async function handleApprovePlan(taskSessionId: string) {
    if (!state.workspaceRoot || state.loading || state.streaming) return null;

    try {
      const { session } = await approveTaskPlan(taskSessionId);
      if (!session) return null;
      mergeTaskSession(session);
      return session;
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "批准计划失败" }));
      return null;
    }
  }

  async function handleOpenTaskSession(taskSessionId: string) {
    if (!state.workspaceRoot) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const [{ sessions }, { session }] = await Promise.all([fetchTaskSessions(), fetchTaskSession(taskSessionId)]);
      setState((current) => ({ ...current, loading: false, taskSessions: sessions, selectedTaskSession: session, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "加载任务历史失败" }));
    }
  }

  async function handleRefreshTaskSessions() {
    try {
      await refreshTaskSessions(state.selectedTaskSession?.id || null);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "刷新任务历史失败" }));
    }
  }

  return {
    refreshTaskSessions,
    handleAddPlanItem,
    handleUpdatePlanItem,
    handleDeletePlanItem,
    handleRewritePlan,
    handleApprovePlan,
    handleOpenTaskSession,
    handleRefreshTaskSessions
  };
}
