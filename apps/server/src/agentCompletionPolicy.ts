import type { AgentRuntimeStatus } from "./types.js";
import type { TaskWorkflowType } from "./taskWorkflow/index.js";

export type CompletionEvidence = {
  workflowType?: TaskWorkflowType;
  mutationExpected: boolean;
  changedFileCount: number;
  generatedPatchCount: number;
  pendingPlanCount: number;
  blockedPlanCount: number;
  validationStatus: "not_required" | "not_run" | "passed" | "failed" | "unavailable";
  pendingApprovalCount: number;
  activeCommandCount: number;
  failedToolCallCount: number;
  lastMutationAt?: number;
  lastValidationAt?: number;
};

export type CompletionDecision = {
  status: Extract<AgentRuntimeStatus, "completed" | "awaiting_approval" | "incomplete" | "blocked">;
  reason: string;
  shouldRecover: boolean;
};

export type CompletionPolicyInput = {
  evidence: CompletionEvidence;
  finalContent: string;
  recoveryAttempted: boolean;
  editingToolsAvailable: boolean;
};

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

  if (evidence.generatedPatchCount > 0) {
    return {
      status: "awaiting_approval",
      reason: "已生成待审核补丁，任务等待用户审批。",
      shouldRecover: false
    };
  }

  // 分析型任务的交付物就是结论文本，不套用文件变更条件。
  if (!evidence.mutationExpected) {
    return {
      status: "completed",
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
      reason: "仍有工具调用等待用户审批。",
      shouldRecover: false
    };
  }

  if (evidence.blockedPlanCount > 0 || finalContentHasNonRecoverableBlock(input.finalContent)) {
    return {
      status: "blocked",
      reason: "任务缺少必须由用户或外部条件解除的阻塞条件。",
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
      reason: "文件变更、计划、工具状态与验证证据均满足完成条件。",
      shouldRecover: false
    };
  }

  return {
    status: "incomplete",
    reason: evidence.changedFileCount === 0
      ? "编辑任务没有生成补丁，也没有产生已应用文件变更。"
      : claimsIncomplete
        ? "最终回答明确表示任务尚未完成。"
        : evidence.activeCommandCount > 0
          ? "仍有命令正在运行，不能确认验证结果。"
          : evidence.failedToolCallCount > 0
            ? "本轮仍存在失败的工具调用。"
            : evidence.validationStatus === "failed"
              ? "验证命令执行失败。"
              : evidence.validationStatus === "not_run" || evidence.validationStatus === "not_required"
                ? "编辑任务尚未运行必要验证。"
                : !validationIsCurrent
                  ? "最近一次验证早于最后一次文件变更，需要重新验证。"
        : "编辑任务仍有未完成的计划步骤。",
    shouldRecover: !input.recoveryAttempted && input.editingToolsAvailable
  };
}

export function createCompletionRecoveryMessage(decision: CompletionDecision, evidence: CompletionEvidence) {
  return {
    role: "user" as const,
    content: [
      "Runtime 完成前检查未通过，本轮不能结束。",
      `原因：${decision.reason}`,
      `当前证据：待审核补丁 ${evidence.generatedPatchCount} 个，已变更文件 ${evidence.changedFileCount} 个，验证状态 ${evidence.validationStatus}，未完成计划 ${evidence.pendingPlanCount} 项，阻塞计划 ${evidence.blockedPlanCount} 项，待审批 ${evidence.pendingApprovalCount} 项，运行中命令 ${evidence.activeCommandCount} 个，失败工具 ${evidence.failedToolCallCount} 次。`,
      "请立即复用已有上下文生成补丁或完成必要的文件写入；不要重复宽泛搜索。若确实需要用户选择、权限、外部状态或受到安全策略限制，请明确说明该不可自动恢复的阻塞条件。"
    ].join("\n")
  };
}
