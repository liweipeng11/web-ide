import type { CommandPolicyResult, CommandResult } from "./types.js";
import type { AgentStep } from "./types.js";

export type ApprovalActionType = "inspect_project" | "search_code" | "read_file" | "edit_files" | "run_command" | "apply_patch";
export type ApprovalRiskLevel = "low" | "medium" | "high";
export type ApprovalRequestStatus = "pending" | "approved" | "rejected" | "auto_approved";

export type AgentStepPayload =
  | {
      type: "message";
      content: string;
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
