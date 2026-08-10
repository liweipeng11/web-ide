import type { AgentProgressSnapshot } from "./agentToolTypes.js";
import type { DeliveryUnit, ToolFailureDiagnostic } from "./types.js";

export type ProgressVector = {
  discoveredFiles: boolean;
  filesRead: boolean;
  negativeEvidence: boolean;
  generatedPatches: boolean;
  modifiedFiles: boolean;
  validationResults: boolean;
  workflowAdvanced: boolean;
  // 阶段 4：子代理完成进展维度，区分"无进展"和"子代理已推进但父代理尚未处理"
  subagentCompleted: boolean;
};

export type ProgressEvaluation = {
  progressed: boolean;
  vector: ProgressVector;
  reasons: string[];
  facts: string[];
};

export type RecoveryAction = "retry_transient" | "switch_strategy" | "replan" | "await_user" | "defer" | "fail";

export type RecoveryDecision = {
  action: RecoveryAction;
  candidateActions: RecoveryAction[];
  reason: string;
  continuation: "continue_current_unit" | "replan" | "await_user_input";
};

/**
 * 根据工具调用前后的结构化快照判断是否形成了可复用证据。
 * 不以工具是否返回文本作为进展依据，避免空搜索与真实发现混淆。
 */
export function evaluateProgress(
  before: AgentProgressSnapshot,
  after: AgentProgressSnapshot,
  activeDeliveryUnit?: DeliveryUnit
): ProgressEvaluation {
  const vector: ProgressVector = {
    discoveredFiles: after.discoveredFiles > before.discoveredFiles || after.searchResults > before.searchResults,
    filesRead: after.filesRead > before.filesRead,
    negativeEvidence: after.negativeEvidence > before.negativeEvidence,
    generatedPatches: after.generatedPatches > before.generatedPatches,
    modifiedFiles: after.modifiedFiles > before.modifiedFiles,
    validationResults: after.commandsRun > before.commandsRun,
    workflowAdvanced: after.completedWorkflowSteps > before.completedWorkflowSteps,
    // 阶段 4：子代理完成进展 — 当父代理本轮回收了子代理结果（subagent_artifacts_recovered）时标记为有进展。
    subagentCompleted: (after.subagentCompleted ?? 0) > (before.subagentCompleted ?? 0)
  };
  const labels: Array<[keyof ProgressVector, string]> = [
    ["discoveredFiles", "发现新的相关文件或搜索结果"],
    ["filesRead", "读取新的可编辑上下文"],
    ["negativeEvidence", "形成新的负面证据"],
    ["generatedPatches", "生成可审核补丁"],
    ["modifiedFiles", "产生已应用文件变更"],
    ["validationResults", "获得新的命令或验证结果"],
    ["workflowAdvanced", "推进任务计划状态"],
    ["subagentCompleted", "子代理完成并回收结果"]
  ];
  const reasons = labels.filter(([key]) => vector[key]).map(([, label]) => label);
  const facts = [
    ...reasons,
    ...(activeDeliveryUnit ? [`当前交付单元：${activeDeliveryUnit.title}`] : [])
  ];
  return { progressed: reasons.length > 0, vector, reasons, facts };
}

/**
 * 在固定上限内选择恢复动作；该函数不执行工具，不能绕过预算、审批或 Safe Editor 门禁。
 */
export function decideRecovery(input: {
  consecutiveNoProgressSteps: number;
  maxNoProgressSteps: number;
  recoveryAttempts: number;
  allowedRecoveryAttempts: number;
  remainingSteps: number;
  activeDeliveryUnit?: DeliveryUnit;
  hasDeliverable: boolean;
  pendingPlanCount: number;
  /** 同一工具调用与错误码组合已自动重试的次数，避免不同错误共享重试额度。 */
  sameFailureRetryCount?: number;
  lastFailure?: Pick<ToolFailureDiagnostic, "errorCategory" | "retryable">;
}): RecoveryDecision {
  const candidateActions: RecoveryAction[] = ["switch_strategy", "replan", "defer"];
  const failureCategory = input.lastFailure?.errorCategory.toLowerCase();
  if (failureCategory === "internal" || failureCategory === "storage_corruption") {
    return { action: "fail", candidateActions: [...candidateActions, "fail"], reason: "检测到不可安全恢复的内部或状态存储错误。", continuation: "await_user_input" };
  }
  if (["permission", "dependency", "conflict", "external"].includes(failureCategory || "")) {
    return { action: "await_user", candidateActions: [...candidateActions, "await_user"], reason: "继续执行需要权限、依赖选择、冲突目标或外部条件的明确决定。", continuation: "await_user_input" };
  }
  if (
    input.lastFailure?.retryable
    && input.recoveryAttempts < input.allowedRecoveryAttempts
    && (input.sameFailureRetryCount ?? 0) < input.allowedRecoveryAttempts
    && input.remainingSteps > 1
  ) {
    return { action: "retry_transient", candidateActions: ["retry_transient", ...candidateActions], reason: "最近一次失败被明确标为可重试，且尚未达到重试上限。", continuation: "continue_current_unit" };
  }
  if (input.recoveryAttempts < input.allowedRecoveryAttempts && input.remainingSteps > 1) {
    return { action: "switch_strategy", candidateActions, reason: `连续 ${input.consecutiveNoProgressSteps}/${input.maxNoProgressSteps} 次未形成新证据，要求改用精确读取、文件计划、补丁或验证。`, continuation: "continue_current_unit" };
  }
  if (input.activeDeliveryUnit && input.pendingPlanCount > 0) {
    return { action: "replan", candidateActions, reason: "当前交付单元仍有待处理计划，但现有信息或边界不足，需保留事实后重新规划。", continuation: "replan" };
  }
  if (input.hasDeliverable || input.pendingPlanCount > 0) {
    return { action: "defer", candidateActions, reason: "已保留交付物或明确后续工作，结束本次运行并提供可继续建议。", continuation: "replan" };
  }
  return { action: "defer", candidateActions, reason: "未形成可安全执行的下一步，已停止本次运行以避免无效循环。", continuation: "replan" };
}
