import type { AgentResult, Plan } from "../../runtime/contracts.js";

export const DEFAULT_MAX_REPLANS = 3;
export const SAME_TASK_FAILURE_REPLAN_THRESHOLD = 3;

const LOCAL_RECOVERY_PATTERN = /FILE_NOT_FOUND|NO_MATCH|NOT_FOUND|lint|format|semicolon|分号|格式/i;

export type MainReplanDecision = {
  shouldReplan: boolean;
  reason: string;
  source: "rule" | "semantic" | "fallback";
};

export type ReplanPolicyInput = {
  plan: Plan;
  result: AgentResult;
  sameTaskFailures: number;
  forceReason?: string;
};

export type ReplanRuleEvaluation = MainReplanDecision | { shouldReplan: null; reason: string };

/**
 * 先处理可确定的结构化信号；只有计划假设与新事实可能冲突时才交给语义模型。
 */
export function evaluateReplanRules(input: ReplanPolicyInput): ReplanRuleEvaluation {
  if (input.forceReason?.trim()) {
    return { shouldReplan: true, reason: input.forceReason.trim(), source: "rule" };
  }

  const diagnosticText = [input.result.summary, ...input.result.blockers, ...input.result.evidence].join("\n");
  if (LOCAL_RECOVERY_PATTERN.test(diagnosticText)) {
    return {
      shouldReplan: false,
      reason: "结果属于局部工具或格式问题，应在当前任务内恢复，不需要重新规划。",
      source: "rule"
    };
  }

  if (input.sameTaskFailures >= SAME_TASK_FAILURE_REPLAN_THRESHOLD) {
    return {
      shouldReplan: true,
      reason: `任务 ${input.result.taskId} 已连续失败 ${input.sameTaskFailures} 次，当前任务拆分或执行路径需要调整。`,
      source: "rule"
    };
  }

  if (!input.plan.assumptions.length || !input.result.facts.length) {
    return { shouldReplan: false, reason: "没有发现会改变计划结构的新事实。", source: "rule" };
  }

  return { shouldReplan: null, reason: "需要判断新事实是否推翻计划中的关键假设。" };
}

export function buildReplanSemanticInput(input: ReplanPolicyInput) {
  return JSON.stringify({
    goal: input.plan.goal,
    assumptions: input.plan.assumptions,
    newFacts: input.result.facts,
    currentTask: input.result.taskId,
    resultStatus: input.result.status
  });
}
