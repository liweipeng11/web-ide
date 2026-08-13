import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelSelection, ModelUsage } from "./contracts/model.js";

export type ModelExecutionContext = {
  selection: ModelSelection;
  taskSessionId: string | null;
  mode: "chat" | "plan" | "act";
  budget: ModelCallBudget;
};

export type ModelCallBudget = {
  usedCalls: number;
  usedInputTokens: number;
  usedOutputTokens: number;
};

export type ModelExecutionBudgetPolicy = {
  maxModelCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
};

export type ModelBudgetExceededReason = "calls" | "input_tokens" | "output_tokens";

export type ModelBudgetConsumeResult =
  | { allowed: true; budget: ModelCallBudget }
  | { allowed: false; reason: ModelBudgetExceededReason; budget: ModelCallBudget };

const storage = new AsyncLocalStorage<ModelExecutionContext>();
const taskBudgets = new Map<string, ModelCallBudget>();

function createBudget(): ModelCallBudget {
  return { usedCalls: 0, usedInputTokens: 0, usedOutputTokens: 0 };
}

function resolveBudget(taskSessionId: string | null) {
  if (!taskSessionId) return createBudget();
  const existing = taskBudgets.get(taskSessionId);
  if (existing) return existing;
  const created = createBudget();
  taskBudgets.set(taskSessionId, created);
  return created;
}

/** 将一次任务内的分类、计划、聊天和编辑请求绑定到同一模型。 */
export function withModelExecution<T>(context: Omit<ModelExecutionContext, "budget">, callback: () => T): T {
  return storage.run({ ...context, budget: resolveBudget(context.taskSessionId) }, callback);
}

export function getModelExecutionContext() {
  return storage.getStore();
}

export function getActiveModelId(fallback: string) {
  return storage.getStore()?.selection.modelId || fallback;
}

/** 任务结束后释放预算状态，避免已完成会话持续占用内存。 */
export function clearModelExecutionBudget(taskSessionId: string | null | undefined) {
  if (taskSessionId) taskBudgets.delete(taskSessionId);
}

/** 返回 false 时表示本次调用会超出任务级模型调用预算。 */
export function consumeModelExecutionBudget(policy: ModelExecutionBudgetPolicy): ModelBudgetConsumeResult {
  const context = storage.getStore();
  if (!context) return { allowed: true, budget: createBudget() };
  if (context.budget.usedCalls >= policy.maxModelCalls) return { allowed: false, reason: "calls", budget: context.budget };
  if (context.budget.usedInputTokens >= policy.maxInputTokens) return { allowed: false, reason: "input_tokens", budget: context.budget };
  if (context.budget.usedOutputTokens >= policy.maxOutputTokens) return { allowed: false, reason: "output_tokens", budget: context.budget };
  context.budget.usedCalls += 1;
  return { allowed: true, budget: context.budget };
}

/** Provider 返回 Usage 后累计到本轮任务预算，下一次请求前据此进行限额判断。*/
export function recordModelExecutionUsage(usage: ModelUsage) {
  const context = storage.getStore();
  if (!context) return;
  context.budget.usedInputTokens += Math.max(0, usage.inputTokens || 0);
  context.budget.usedOutputTokens += Math.max(0, usage.outputTokens || 0);
}
