import type { AgentRuntimeStatus, CompletionRejectionCode, PendingPlanItemSummary } from "./types.js";
import type { TaskWorkflowType } from "./taskWorkflow/index.js";

export type CompletionEvidence = {
  workflowType?: TaskWorkflowType;
  mutationExpected: boolean;
  changedFileCount: number;
  /** 历史生成数量仅用于审计，不能据此判断补丁当前是否仍待处理。 */
  generatedPatchCount: number;
  /** 当前仍存在于 pending patch store、尚未应用或拒绝的补丁数量。 */
  pendingPatchCount?: number;
  pendingPlanCount: number;
  blockedPlanCount: number;
  pendingPlanItems?: PendingPlanItemSummary[];
  validationStatus: "not_required" | "not_run" | "passed" | "failed" | "unavailable";
  pendingApprovalCount: number;
  activeCommandCount: number;
  failedToolCallCount: number;
  lastMutationAt?: number;
  lastValidationAt?: number;
};

export type CompletionDecision = {
  status: Extract<AgentRuntimeStatus, "completed" | "awaiting_approval" | "incomplete" | "blocked">;
  code: CompletionRejectionCode | "COMPLETED";
  reason: string;
  suggestedAction?: string;
  pendingPlanItems?: PendingPlanItemSummary[];
  shouldRecover: boolean;
};

export type CompletionPolicyInput = {
  evidence: CompletionEvidence;
  finalContent: string;
  recoveryAttempted: boolean;
  editingToolsAvailable: boolean;
};

export type CompletionEvidenceFingerprintInput = Pick<CompletionEvidence,
  | "changedFileCount"
  | "generatedPatchCount"
  | "pendingPatchCount"
  | "validationStatus"
  | "pendingPlanCount"
  | "blockedPlanCount"
  | "pendingApprovalCount"
  | "activeCommandCount"
  | "lastMutationAt"
  | "lastValidationAt"
  | "pendingPlanItems"
>;

export type CompletionRejectionState = {
  fingerprint: string;
  rejectionCode: string;
  consecutiveCount: number;
};

/**
 * 统一生成面向模型和 UI 的结构化拒绝契约，避免不同 Runtime 路径遗漏关键恢复信息。
 */
export function createCompletionRejectionPayload(decision: CompletionDecision) {
  return {
    error: "completion_rejected" as const,
    completionRequested: true,
    completionStatus: decision.status,
    rejectionCode: decision.code,
    message: decision.reason,
    suggestedAction: decision.suggestedAction,
    pendingPlanItems: decision.pendingPlanItems ?? []
  };
}

/**
 * 只序列化会影响完成裁决的稳定字段，模型改写 summary 不能改变该指纹。
 */
export function createCompletionEvidenceFingerprint(evidence: CompletionEvidenceFingerprintInput) {
  return JSON.stringify([
    evidence.changedFileCount,
    evidence.generatedPatchCount,
    evidence.pendingPatchCount ?? 0,
    evidence.validationStatus,
    evidence.pendingPlanCount,
    evidence.blockedPlanCount,
    evidence.pendingApprovalCount,
    evidence.activeCommandCount,
    // 展示标题可能包含业务文本且不影响完成裁决，指纹只保留稳定步骤与状态。
    (evidence.pendingPlanItems ?? []).map((item) => [item.workflowStepId ?? null, item.status]),
    evidence.lastMutationAt ?? null,
    evidence.lastValidationAt ?? null
  ]);
}

/**
 * 证据指纹是连续性的唯一依据；拒绝代码仅用于诊断，避免模型改写 summary 后重置计数。
 */
export function advanceCompletionRejectionState(
  previous: CompletionRejectionState | undefined,
  evidence: CompletionEvidenceFingerprintInput,
  rejectionCode: string
): CompletionRejectionState {
  const fingerprint = createCompletionEvidenceFingerprint(evidence);
  const consecutiveCount = previous?.fingerprint === fingerprint
    ? previous.consecutiveCount + 1
    : 1;
  return { fingerprint, rejectionCode, consecutiveCount };
}

export function createCompletionRejectionGuidance(decision: CompletionDecision, consecutiveCount: number) {
  if (consecutiveCount >= 2) {
    return `完成证据没有变化（连续第 ${consecutiveCount} 次拒绝）。禁止再次直接调用 completeTask；必须先执行能改变文件、验证、计划、审批或命令状态的动作。`;
  }
  const pendingItems = decision.pendingPlanItems?.length
    ? ` 具体计划项：${decision.pendingPlanItems.map((item) => `${item.title}（${item.status}）`).join("、")}。`
    : "";
  return `下一步必须先处理该条件：${decision.reason}${pendingItems} ${decision.suggestedAction ?? "完成实际修改或必要验证后，再调用 completeTask。"}`;
}

const incompleteClaimPatterns = [
  /(?:尚未|还未|未能|没有|无法)(?:完成|实现|修改|创建|生成|应用|验证)/i,
  /(?:任务|修改|实现).{0,12}(?:未完成|无法完成)/i,
  /\b(?:not completed|incomplete|unable to (?:complete|implement|modify|create|apply|validate)|could not (?:complete|implement|modify|create|apply|validate))\b/i,
  /(?:请|需要).{0,8}(?:手动|自行)(?:创建|修改|应用|完成)/i
];

const nonRecoverableBlockPatterns = [
  /(?:需要|请).{0,12}(?:用户|您).{0,12}(?:选择|决定|确认|提供)/i,
  /(?:缺少|没有|需要).{0,12}(?:权限|授权|访问权)/i,
  /(?:安全策略|安全规则|策略禁止).{0,12}(?:禁止|阻止|不允许|继续)/i,
  /(?:外部状态|外部条件|外部服务).{0,16}(?:无法|不能).{0,8}(?:获取|访问|确认)/i,
  /\b(?:requires? (?:user )?(?:choice|decision|confirmation)|missing (?:permission|authorization)|security policy (?:blocks|prohibits)|external state (?:is )?unavailable)\b/i
];

export function finalContentClaimsIncomplete(content: string) {
  const normalized = content.trim();
  return normalized.length > 0 && incompleteClaimPatterns.some((pattern) => pattern.test(normalized));
}

export function finalContentHasNonRecoverableBlock(content: string) {
  const normalized = content.trim();
  return normalized.length > 0 && nonRecoverableBlockPatterns.some((pattern) => pattern.test(normalized));
}

/**
 * 使用可审计的交付证据判定终态，禁止把“模型返回文本”直接等价为任务完成。
 */
export function evaluateAgentCompletion(input: CompletionPolicyInput): CompletionDecision {
  const { evidence } = input;

  if ((evidence.pendingPatchCount ?? 0) > 0) {
    return {
      status: "awaiting_approval",
      code: "PENDING_APPROVAL",
      reason: "已生成待审核补丁，任务等待用户审批。",
      suggestedAction: "审核并应用待处理补丁后，再请求完成任务。",
      pendingPlanItems: evidence.pendingPlanItems ?? [],
      shouldRecover: false
    };
  }

  // 分析型任务的交付物就是结论文本，不套用文件变更条件。
  if (!evidence.mutationExpected) {
    return {
      status: "completed",
      code: "COMPLETED",
      reason: "只读分析任务已返回结论。",
      shouldRecover: false
    };
  }

  const claimsIncomplete = finalContentClaimsIncomplete(input.finalContent);
  const hasPendingWork = evidence.pendingPlanCount > 0 || evidence.blockedPlanCount > 0;
  const validationPassed = evidence.validationStatus === "passed" || evidence.validationStatus === "unavailable";
  const validationIsCurrent = evidence.lastMutationAt === undefined
    || evidence.validationStatus === "unavailable"
    || (evidence.lastValidationAt !== undefined && evidence.lastValidationAt >= evidence.lastMutationAt);

  if (evidence.pendingApprovalCount > 0) {
    return {
      status: "awaiting_approval",
      code: "PENDING_APPROVAL",
      reason: "仍有工具调用等待用户审批。",
      suggestedAction: "批准或拒绝待处理工具调用，Runtime 将在审批后继续。",
      pendingPlanItems: evidence.pendingPlanItems ?? [],
      shouldRecover: false
    };
  }

  // 可定位的验证失败优先进入回修闭环。否则被遗留的计划阻塞项抢占后，
  // Runtime 只会要求重新规划，模型不会回到已经给出文件行号的错误上。
  if (evidence.validationStatus === "failed") {
    return {
      status: "incomplete",
      code: "VALIDATION_FAILED",
      reason: "验证命令执行失败。",
      suggestedAction: "复用最近一次失败命令的结果定位问题，修复对应文件，再使用 runCommand 重新运行验证。",
      pendingPlanItems: evidence.pendingPlanItems ?? [],
      shouldRecover: !input.recoveryAttempted && input.editingToolsAvailable
    };
  }

  if (evidence.blockedPlanCount > 0 || finalContentHasNonRecoverableBlock(input.finalContent)) {
    return {
      status: "blocked",
      code: "PENDING_PLAN",
      reason: "任务缺少必须由用户或外部条件解除的阻塞条件。",
      suggestedAction: "处理被阻塞的计划项，或提供所需的选择、权限和外部信息。",
      pendingPlanItems: evidence.pendingPlanItems ?? [],
      shouldRecover: false
    };
  }

  if (
    evidence.changedFileCount > 0
    && !hasPendingWork
    && evidence.activeCommandCount === 0
    && evidence.failedToolCallCount === 0
    && validationPassed
    && validationIsCurrent
    && !claimsIncomplete
  ) {
    return {
      status: "completed",
      code: "COMPLETED",
      reason: "文件变更、计划、工具状态与验证证据均满足完成条件。",
      shouldRecover: false
    };
  }

  const rejection = evidence.changedFileCount === 0
    ? {
        code: "NO_MUTATION_EVIDENCE" as const,
        reason: validationPassed
          ? "构建已经通过，但当前恢复运行缺少文件变更证据。"
          : "未找到本次任务的文件变更证据。",
        suggestedAction: "执行文件编辑，或恢复跨审批持久化的文件变更证据。"
      }
    : claimsIncomplete
      ? {
          code: "INCOMPLETE_CLAIM" as const,
          reason: "最终回答明确表示任务尚未完成。",
          suggestedAction: "完成声明中的未解决事项后，再请求完成任务。"
        }
      : evidence.activeCommandCount > 0
        ? {
            code: "ACTIVE_COMMAND" as const,
            reason: "仍有命令正在运行，不能确认验证结果。",
            suggestedAction: "等待运行中的命令结束并记录结果。"
          }
        : evidence.failedToolCallCount > 0
          ? {
              code: "FAILED_TOOL_CALL" as const,
              reason: "本轮仍存在失败的工具调用。",
              suggestedAction: "修复工具调用错误并重新执行必要步骤。"
            }
          : evidence.validationStatus === "not_run" || evidence.validationStatus === "not_required"
              ? {
                  code: "VALIDATION_NOT_RUN" as const,
                  reason: "编辑任务尚未运行必要验证。",
                  suggestedAction: "使用 runCommand 运行与本次变更相关的类型检查、测试或构建。"
                }
              : !validationIsCurrent
                ? {
                    code: "VALIDATION_STALE" as const,
                    reason: "最近一次验证早于最后一次文件变更，需要重新验证。",
                    suggestedAction: "在最后一次文件变更后重新运行验证。"
                  }
                : {
                    code: "PENDING_PLAN" as const,
                    reason: "编辑任务仍有未完成的计划步骤。",
                    suggestedAction: (evidence.pendingPlanItems ?? []).some((item) => item.workflowStepId)
                      ? "Runtime 已先执行系统计划校准；请完成上述系统步骤对应的实际工作。"
                      : "逐项完成上述自定义计划，或明确记录其阻塞原因。"
                  };

  return {
    status: "incomplete",
    ...rejection,
    pendingPlanItems: evidence.pendingPlanItems ?? [],
    shouldRecover: !input.recoveryAttempted && input.editingToolsAvailable
  };
}

export function createCompletionRecoveryMessage(decision: CompletionDecision, evidence: CompletionEvidence) {
  return {
    role: "user" as const,
    content: [
      "Runtime 完成前检查未通过，本轮不能结束。",
      `拒绝代码：${decision.code}`,
      `原因：${decision.reason}`,
      `当前证据：待审核补丁 ${evidence.pendingPatchCount ?? 0} 个，历史生成补丁 ${evidence.generatedPatchCount} 个，已变更文件 ${evidence.changedFileCount} 个，验证状态 ${evidence.validationStatus}，未完成计划 ${evidence.pendingPlanCount} 项，阻塞计划 ${evidence.blockedPlanCount} 项，待审批 ${evidence.pendingApprovalCount} 项，运行中命令 ${evidence.activeCommandCount} 个，失败工具 ${evidence.failedToolCallCount} 次。`,
      `建议动作：${decision.suggestedAction ?? "根据当前证据补齐未完成条件。"}`,
      ...(decision.pendingPlanItems?.length
        ? [`具体未完成计划：${decision.pendingPlanItems.map((item) => `${item.workflowStepId ?? "custom"}:${item.title}（${item.status}）`).join("；")}`]
        : []),
      "请立即复用已有上下文继续处理；不要重复宽泛搜索。若确实需要用户选择、权限、外部状态或受到安全策略限制，请明确说明该不可自动恢复的阻塞条件。"
    ].join("\n")
  };
}
