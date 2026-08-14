import type { AgentStep } from "../../types.js";
import { runtimeError } from "../../runtime/errors.js";
import type { PatchApprovalStateValue } from "./patchApprovalState.js";

export type PatchApprovalDecision = "approved" | "rejected";

export interface PatchApprovalDecisionResult {
  state: PatchApprovalStateValue;
  replayed: boolean;
}

function expiredState(state: PatchApprovalStateValue, decidedAt: number): PatchApprovalStateValue {
  return {
    ...state,
    status: "expired",
    decidedAt,
    resolutionSource: "timeout"
  };
}

/**
 * 解析用户决定；终态可安全重放，但同一个 action 不允许从批准改成拒绝或反向修改。
 * 函数是纯状态转换，批准结果不会在本工作包中触发 Patch 应用。
 */
export function resolvePatchApproval(
  state: PatchApprovalStateValue,
  input: { actionId: string; decision: PatchApprovalDecision; decidedAt?: number }
): PatchApprovalDecisionResult {
  if (input.actionId !== state.approvalActionId) {
    throw runtimeError("INVALID_CONTRACT", "Patch 审批 actionId 不匹配。", {
      expectedActionId: state.approvalActionId,
      actualActionId: input.actionId
    });
  }
  if (state.status === "expired") return { state, replayed: true };
  if (state.status !== "pending") {
    if (state.status === input.decision) return { state, replayed: true };
    throw runtimeError("INVALID_STATE_TRANSITION", `Patch 审批已经是 ${state.status}，不能改为 ${input.decision}。`, {
      actionId: state.approvalActionId,
      currentStatus: state.status,
      requestedStatus: input.decision
    });
  }

  const decidedAt = input.decidedAt ?? Date.now();
  if (!Number.isFinite(decidedAt) || decidedAt < state.requestedAt) {
    throw runtimeError("INVALID_CONTRACT", "Patch 审批决定时间无效。", { decidedAt });
  }
  if (decidedAt >= state.expiresAt) {
    return { state: expiredState(state, decidedAt), replayed: false };
  }
  return {
    state: {
      ...state,
      status: input.decision,
      decidedAt,
      resolutionSource: "user"
    },
    replayed: false
  };
}

/** 定时检查只把 pending 转为 expired，不改变已完成的人工决定。 */
export function expirePatchApproval(
  state: PatchApprovalStateValue,
  currentTime = Date.now()
): PatchApprovalDecisionResult {
  if (state.status !== "pending") return { state, replayed: true };
  if (!Number.isFinite(currentTime) || currentTime < state.expiresAt) return { state, replayed: true };
  return { state: expiredState(state, currentTime), replayed: false };
}

/** 转换为现有前端协议；details 只包含可审计 ID，不包含 Patch 正文。 */
export function patchApprovalAgentStep(state: PatchApprovalStateValue): AgentStep {
  return {
    id: `approval_request:${state.approvalActionId}`,
    createdAt: state.requestedAt,
    type: "approval_request",
    actionId: state.approvalActionId,
    actionType: "apply_patch",
    title: "审核并应用候选 Patch",
    summary: `待审核 ${state.filePaths.length} 个文件的候选修改。`,
    riskLevel: "high",
    status: state.status === "pending" ? "pending" : state.status === "approved" ? "approved" : "rejected",
    targets: [...state.filePaths],
    details: {
      source: "langgraph_patch_approval",
      taskId: state.taskId,
      graphRunId: state.graphRunId,
      patchId: state.patchId,
      applyActionId: state.applyActionId,
      resolution: state.status
    }
  };
}

