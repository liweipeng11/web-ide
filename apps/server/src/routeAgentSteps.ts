import type { CommandPolicyResult, CommandResult } from "./types.js";
import type { AgentStep } from "./types.js";

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
    };

export function createAgentStep(step: AgentStepPayload): AgentStep {
  return {
    id: `${step.type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
    ...step
  };
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

