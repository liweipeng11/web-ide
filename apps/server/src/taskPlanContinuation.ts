import type { AgentRuntimeStatus, TaskPlanItem } from "./types.js";

/**
 * 单次请求内最多额外续跑两次：一次用于切换策略，另一次用于执行切换后的具体步骤。
 * 每轮仍要求没有补丁和待审批操作，避免工具失败时形成无限循环。
 */
export const MAX_AUTOMATIC_PLAN_CONTINUATIONS = 2;

export type TaskPlanContinuationDecision = {
  shouldContinue: boolean;
  planItem?: TaskPlanItem;
};

/**
 * 选取当前正在执行的步骤；没有进行中步骤时，才选择第一个待办步骤。
 * 这样不会跳过用户在计划面板中手动调整过的顺序。
 */
export function selectActiveTaskPlanItem(planItems: TaskPlanItem[] | undefined) {
  return planItems?.find((item) => item.status === "in_progress")
    ?? planItems?.find((item) => item.status === "pending");
}

/**
 * Runtime 的 incomplete 代表本轮未交付，而不是任务已经结束。
 * 只有没有审批、补丁或明确阻塞时，才允许由服务端安全地续跑一次。
 */
export function decideTaskPlanContinuation(input: {
  runtimeStatus: AgentRuntimeStatus;
  continuationCount: number;
  hasPendingToolCall: boolean;
  generatedPatchCount: number;
  planItems: TaskPlanItem[] | undefined;
}): TaskPlanContinuationDecision {
  const planItem = selectActiveTaskPlanItem(input.planItems);
  const shouldContinue = input.runtimeStatus === "incomplete"
    && input.continuationCount < MAX_AUTOMATIC_PLAN_CONTINUATIONS
    && !input.hasPendingToolCall
    && input.generatedPatchCount === 0
    && Boolean(planItem);

  return { shouldContinue, planItem };
}

/** 为续跑轮次注入精确目标，避免模型重新进行宽泛目录搜索。 */
export function buildTaskPlanContinuationRequest(userGoal: string, planItem: TaskPlanItem) {
  return [
    `原始任务：${userGoal.trim()}`,
    `当前必须完成的计划步骤：${planItem.title}${planItem.note ? `（${planItem.note}）` : ""}`,
    "上一轮未形成文件变更、补丁或验证证据。请复用已读取的上下文，禁止重复宽泛搜索。",
    "现在只处理该步骤：若可编辑，先声明文件修改计划并生成补丁；若确实受权限、依赖或外部状态阻塞，明确说明具体阻塞原因。"
  ].join("\n");
}
