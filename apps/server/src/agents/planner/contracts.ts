import type { AgentState, Plan } from "../../runtime/contracts.js";

export type PlannerScope = {
  readScope: string[];
  writeScope: string[];
};

/** Planner 创建计划时只消费 Main 提供的目标、事实和安全边界。 */
export interface PlannerCreatePlanInput extends PlannerScope {
  goal: string;
  knownFacts: string[];
  constraints: string[];
  state: Readonly<AgentState>;
}

/** 重规划输入显式携带旧计划和已完成任务，避免模型覆盖可信进度。 */
export interface PlannerReplanInput extends PlannerScope {
  oldPlan: Plan;
  completedTasks: string[];
  newFacts: string[];
  constraints: string[];
  state: Readonly<AgentState>;
}

export type PlannerReadyResult = {
  status: "ready";
  plan: Plan;
};

export type PlannerMissingContextResult = {
  status: "missing_context";
  required: string[];
};

export type PlannerFailedResult = {
  status: "failed";
  reason: "invalid_input" | "invalid_plan" | "model_error";
  blockers: string[];
};

export type PlannerResult = PlannerReadyResult | PlannerMissingContextResult | PlannerFailedResult;
