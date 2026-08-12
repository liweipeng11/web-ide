import type { CommandPolicyResult, CommandResult } from "./types.js";
import type { AgentStep } from "./types.js";
import type { SubagentKind, SubagentDelegationScope, SubagentBudgetPolicy, SubagentArtifactsKind, SubagentFailure } from "./agentToolTypes.js";

export type ApprovalActionType = "inspect_project" | "search_code" | "read_file" | "edit_files" | "run_command" | "apply_patch" | "write_file" | "delete_file" | "ask_user" | "tool_call";
export type ApprovalRiskLevel = "low" | "medium" | "high";
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "auto_approved";

export type AgentStepPayload =
  | {
      type: "message";
      content: string;
    }
  | {
      type: "strategy";
      event:
        | "repeated_tool_warning"
        | "repeated_tool_blocked"
        | "negative_evidence"
        | "create_intent"
        | "create_intent_search_blocked"
        | "no_progress_recovery"
        | "completion_recovery"
        | "budget_convergence"
        | "no_progress_stop"
        | "unit_context_exploration_blocked"
        | "budget_stop";
      message: string;
      toolName?: string;
      repeatCount?: number;
      currentStep?: number;
      maxSteps?: number;
      facts?: string[];
    }
  | {
      type: "approval_request";
      actionId: string;
      actionType: ApprovalActionType;
      title: string;
      summary: string;
      riskLevel: ApprovalRiskLevel;
      status: ApprovalRequestStatus;
      targets?: string[];
      command?: string;
      details?: unknown;
    }
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
    }
  | Omit<Extract<AgentStep, { type: "workflow_decision" }>, "id" | "createdAt">
  | {
      type: "edit";
      files: string[];
    }
  | {
      type: "command";
      command: string;
      policy?: CommandPolicyResult;
      status?: "suggested" | "running" | "success" | "failed" | "blocked" | "cancelled";
      result?: CommandResult | null;
    }
  | {
      type: "checkpoint";
      checkpointId: string;
      files: string[];
      source?: {
        taskSessionId?: string | null;
        toolCallId?: string | null;
        toolName?: string | null;
        actionId?: string | null;
        patchId?: string | null;
        reason?: string | null;
      };
    }
  | {
      type: "error";
      message: string;
    }
  | Omit<Extract<AgentStep, { type: "completion_rejected" }>, "id" | "createdAt">
  | Omit<Extract<AgentStep, { type: "tool_blocked" }>, "id" | "createdAt">
  | Omit<Extract<AgentStep, { type: "delivery_unit_started" | "delivery_unit_completed" | "replan_requested" | "awaiting_user_decision" | "tool_failure_recorded" }>, "id" | "createdAt">
  | Omit<Extract<AgentStep, { type: "orchestration" }>, "id" | "createdAt">;

export function createAgentStep(step: AgentStepPayload): AgentStep {
  return {
    id: `${step.type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    ...step
  };
}

/** 阶段 1 的交付编排事件统一提供中文说明，避免调用方遗漏可展示文本。 */
export function createProgressiveDeliveryStep(input: {
  event: "delivery_unit_started" | "delivery_unit_completed" | "replan_requested" | "awaiting_user_decision" | "tool_failure_recorded";
  details: Record<string, unknown>;
  message?: string;
}) {
  const defaultMessages = {
    delivery_unit_started: "已开始执行当前交付单元。",
    delivery_unit_completed: "当前交付单元已完成并通过验证。",
    replan_requested: "当前信息不足，已请求重新规划。",
    awaiting_user_decision: "任务需要你的决策后才能继续。",
    tool_failure_recorded: "已记录工具调用失败诊断。"
  } as const;
  return createAgentStep({ type: input.event, message: input.message?.trim() || defaultMessages[input.event], details: input.details });
}

export function createApprovalRequestStep(input: {
  actionType: ApprovalActionType;
  title: string;
  summary: string;
  riskLevel?: ApprovalRiskLevel;
  status?: ApprovalRequestStatus;
  targets?: string[];
  command?: string;
  details?: unknown;
}): AgentStep {
  return createAgentStep({
    type: "approval_request",
    actionId: `${input.actionType}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    actionType: input.actionType,
    title: input.title,
    summary: input.summary,
    riskLevel: input.riskLevel || "low",
    status: input.status || "pending",
    targets: input.targets,
    command: input.command,
    details: input.details
  });
}

// 阶段 1：子代理生命周期步骤创建函数，供父代理 Runtime 在委派、执行、回收各阶段发送标准步骤。

/** 父代理创建子代理委派时发送，记录委派身份、目标、范围和预算。 */
export function createSubagentCreatedStep(input: {
  delegationId: string;
  subagentId: string;
  title: string;
  kind: SubagentKind;
  goal: string;
  scope: SubagentDelegationScope;
  budget: SubagentBudgetPolicy;
}): AgentStep {
  const type = "subagent_created" as const;
  return { id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), type, ...input } as AgentStep;
}

/** 子代理开始执行时发送，记录 parentRunId 和子代理自身 runId，塑造父子运行树。 */
export function createSubagentStartedStep(input: {
  delegationId: string;
  subagentId: string;
  parentRunId: string;
  runId: string;
  mode: string;
}): AgentStep {
  const type = "subagent_started" as const;
  return { id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), type, ...input } as AgentStep;
}

/** 子代理成功完成时发送，记录产物类型、摘要和产出补丁数。 */
export function createSubagentSucceededStep(input: {
  delegationId: string;
  subagentId: string;
  artifactsKind: SubagentArtifactsKind;
  summary: string;
  relevantFiles?: string[];
  producedPatchCount?: number;
}): AgentStep {
  const type = "subagent_succeeded" as const;
  return { id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), type, ...input } as AgentStep;
}

/** 子代理执行失败时发送，记录失败原因、可恢复性和预算/超时标志。 */
export function createSubagentFailedStep(input: {
  delegationId: string;
  subagentId: string;
  failure: SubagentFailure;
}): AgentStep {
  const type = "subagent_failed" as const;
  return { id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), type, ...input } as AgentStep;
}

/** 子代理被取消时发送（用户主动取消或父代理中断委派）。 */
export function createSubagentCancelledStep(input: {
  delegationId: string;
  subagentId: string;
  reason?: string;
}): AgentStep {
  const type = "subagent_cancelled" as const;
  return { id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), type, ...input } as AgentStep;
}

/** 父代理从会话历史恢复子代理产物时发送，区分来源（当前运行/历史/审批恢复）。 */
export function createSubagentArtifactsRecoveredStep(input: {
  delegationId: string;
  subagentId: string;
  artifactsKind: SubagentArtifactsKind;
  summary: string;
  source: "current_run" | "task_session_history" | "approval_resume";
}): AgentStep {
  const type = "subagent_artifacts_recovered" as const;
  return { id: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`, createdAt: Date.now(), type, ...input } as AgentStep;
}
