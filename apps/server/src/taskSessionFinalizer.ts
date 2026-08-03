import type { CompletionEvidence } from "./agentCompletionPolicy.js";
import { commitTaskSessionFinalization, reconcileTaskPlanFromRuntimeEvidence, updateTaskSessionStatus } from "./taskSessionStore.js";
import { isTerminalTaskSessionStatus, resolvePlanModeTaskStatus, resolveRuntimeTaskStatus } from "./taskWorkflow/index.js";
import type { TaskWorkflowType } from "./taskWorkflow/index.js";
import type { AgentRuntimeStatus, TaskSessionFinalizationSource, TaskSessionStatus } from "./types.js";

export type TaskSessionFinalizerRuntimeResult = {
  status: AgentRuntimeStatus | "failed" | "cancelled";
  requestedStatus?: AgentRuntimeStatus;
  statusReason?: string;
  completionEvidence?: CompletionEvidence;
};

export type FinalizeTaskSessionInput = {
  taskSessionId: string | null | undefined;
  runtimeResult?: TaskSessionFinalizerRuntimeResult | null;
  clientClosed?: boolean;
  source: TaskSessionFinalizationSource;
  mode?: "plan" | "act";
  workflowType?: TaskWorkflowType;
};

function resolveTaskSessionStatus(input: FinalizeTaskSessionInput): TaskSessionStatus {
  // 传输中断优先于已有结果，避免响应 close 事件把未送达的结果误记为成功。
  if (input.clientClosed) return "cancelled";

  const runtimeStatus = input.runtimeResult?.status;
  if (!runtimeStatus) {
    throw new Error("finalizeTaskSession 需要 Runtime 结果或明确的客户端断开信号");
  }
  if (runtimeStatus === "failed" || runtimeStatus === "cancelled") return runtimeStatus;
  if (input.mode === "plan") return resolvePlanModeTaskStatus(input.workflowType, runtimeStatus);
  return resolveRuntimeTaskStatus(runtimeStatus);
}

/**
 * 统一任务状态出口：传输层只提供关闭信号，业务终态必须由 Runtime/验证结果决定。
 */
export async function finalizeTaskSession(input: FinalizeTaskSessionInput) {
  const completionEvidence = input.runtimeResult?.completionEvidence;
  await reconcileTaskPlanFromRuntimeEvidence(input.taskSessionId, {
    validationStatus: completionEvidence?.validationStatus === "passed"
      ? "success"
      : completionEvidence?.validationStatus === "failed"
        ? "failed"
        : undefined,
    pendingApprovalCount: completionEvidence?.pendingApprovalCount,
    activeCommandCount: completionEvidence?.activeCommandCount,
    failedToolCallCount: completionEvidence?.failedToolCallCount
  });

  const status = resolveTaskSessionStatus(input);
  const runtimeStatus = input.runtimeResult?.status;
  const runtimeOutcome = runtimeStatus && runtimeStatus !== "failed" && runtimeStatus !== "cancelled"
    ? {
        runtimeStatus,
        requestedStatus: input.runtimeResult?.requestedStatus,
        reason: input.runtimeResult?.statusReason,
        completionEvidence: input.runtimeResult?.completionEvidence
      }
    : undefined;

  if (isTerminalTaskSessionStatus(status)) {
    return commitTaskSessionFinalization(input.taskSessionId, {
      status,
      source: input.clientClosed ? "client_disconnect" : input.source,
      runtimeOutcome
    });
  }

  return updateTaskSessionStatus(input.taskSessionId, status, runtimeOutcome);
}
