import type { AgentRequestClassification } from "../aiClient.js";
import { getTaskWorkflowSteps } from "./workflowDefinitions.js";
import type { TaskWorkflowSnapshot, TaskWorkflowSource, TaskWorkflowType } from "./types.js";

const bugfixPatterns = [/修复|故障|缺陷|回归|报错|错误|异常|失败|崩溃|不生效|无法|不能|bug|fix|error|failed|failure|exception|crash|regression/i];
const refactorPatterns = [/重构|整理结构|拆分模块|解耦|抽象|代码清理|不改变行为|refactor|restructure|decouple|cleanup/i];
const featurePatterns = [/新增|添加|实现|支持|接入|开发|功能|feature|implement|add|introduce|support/i];

type WorkflowSelection = {
  type: TaskWorkflowType;
  source: TaskWorkflowSource;
  confidence: number;
  reason: string;
};

function matchesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

// 先尊重只读和诊断意图，再处理显式任务关键词，避免把“分析如何重构”误判为会修改代码的重构任务。
export function classifyTaskWorkflow(userGoal: string, classification?: AgentRequestClassification): WorkflowSelection {
  const normalizedGoal = (classification?.normalizedGoal || userGoal).trim();

  if (classification?.intent === "inspect" || classification?.intent === "chat") {
    return {
      type: "analysis-only",
      source: "intent",
      confidence: classification.confidence,
      reason: "当前意图只要求分析或说明，不应修改工作区文件。"
    };
  }

  if (classification?.intent === "diagnose_then_edit") {
    return {
      type: "bugfix",
      source: "intent",
      confidence: classification.confidence,
      reason: "任务需要先诊断问题再修改代码，采用缺陷修复流程。"
    };
  }

  if (matchesAny(normalizedGoal, refactorPatterns)) {
    return { type: "refactor", source: "keyword", confidence: 0.9, reason: "任务描述包含明确的重构或结构调整目标。" };
  }

  if (matchesAny(normalizedGoal, bugfixPatterns)) {
    return { type: "bugfix", source: "keyword", confidence: 0.85, reason: "任务描述包含错误、失败或修复类特征。" };
  }

  if (matchesAny(normalizedGoal, featurePatterns) || classification?.intent === "edit") {
    return { type: "feature", source: matchesAny(normalizedGoal, featurePatterns) ? "keyword" : "intent", confidence: classification?.confidence || 0.75, reason: "任务要求新增或实现可交付能力。" };
  }

  return { type: "analysis-only", source: "fallback", confidence: 0.55, reason: "未检测到明确编辑目标，默认采用只读分析流程。" };
}

// 生成不可变的会话快照，后续模板升级不会改写历史任务采用的步骤。
export function createTaskWorkflow(userGoal: string, classification?: AgentRequestClassification): TaskWorkflowSnapshot {
  const selection = classifyTaskWorkflow(userGoal, classification);

  return {
    ...selection,
    steps: getTaskWorkflowSteps(selection.type),
    version: 1,
    selectedAt: Date.now()
  };
}

export function resolvePlanModeTaskStatus(workflowType: TaskWorkflowType | undefined, runtimeStatus: "completed" | "awaiting_approval" | "step_limit_reached" | "no_progress") {
  if (runtimeStatus === "awaiting_approval") return "awaiting_approval" as const;
  if (runtimeStatus !== "completed") return "failed" as const;

  // 编辑型工作流在 Plan 模式只完成了方案设计，保留 paused 状态等待用户切换到 Act 继续。
  return workflowType && workflowType !== "analysis-only" ? "paused" as const : "success" as const;
}
