import {
  evaluateAgentCompletion,
  type CompletionDecision,
  type CompletionEvidence
} from "../../agentCompletionPolicy.js";
import { runtimeError } from "../../runtime/errors.js";
import type { RepairLoopStateValue } from "./repairLoopGraph.js";

export type RepairCompletionEvidenceInput = Omit<
  CompletionEvidence,
  "mutationExpected" | "changedFileCount" | "validationStatus"
> & {
  changedFiles: string[];
};

export type RepairCompletionGateResult =
  | { status: "cancelled"; evidence: CompletionEvidence; reason: string }
  | { status: "blocked" | "incomplete"; evidence: CompletionEvidence; reason: string; decision?: CompletionDecision }
  | { status: "completed"; evidence: CompletionEvidence; reason: string; decision: CompletionDecision };

function validationStatus(loop: RepairLoopStateValue): CompletionEvidence["validationStatus"] {
  if (!loop.tester.validation) return "not_run";
  return loop.tester.validation.status === "passed" ? "passed" : "failed";
}

/** 将 Graph 摘要与 Runtime 事实合并为现有完成策略所需证据，不保存命令输出或源码正文。 */
export function collectRepairCompletionEvidence(
  loop: RepairLoopStateValue,
  input: RepairCompletionEvidenceInput
): CompletionEvidence {
  return {
    ...input,
    mutationExpected: true,
    changedFileCount: new Set(input.changedFiles.map((filePath) => filePath.trim()).filter(Boolean)).size,
    validationStatus: validationStatus(loop)
  };
}

function assertPassedLoopEvidence(loop: RepairLoopStateValue) {
  const validation = loop.tester.validation;
  if (loop.tester.status !== "passed" || !validation || validation.status !== "passed") {
    throw runtimeError("INVALID_CONTRACT", "Repair Loop 的 passed 终态缺少 Tester 通过证据。");
  }
  if (!validation.acceptanceCriteria.length
    || validation.acceptanceCriteria.some((criterion) => criterion.status !== "passed" || !criterion.evidence.length)) {
    throw runtimeError("INVALID_CONTRACT", "Repair Loop 的 passed 终态缺少完整验收条件映射。", {
      taskId: loop.tester.task.id
    });
  }
}

/**
 * Graph 只能请求完成；最终状态继续由统一完成策略根据真实 Runtime 证据裁决。
 */
export function evaluateRepairLoopCompletion(input: {
  loop: RepairLoopStateValue;
  evidence: RepairCompletionEvidenceInput;
  finalContent: string;
  recoveryAttempted?: boolean;
  editingToolsAvailable?: boolean;
}): RepairCompletionGateResult {
  const evidence = collectRepairCompletionEvidence(input.loop, input.evidence);
  if (input.loop.outcome === "cancelled") {
    return { status: "cancelled", evidence, reason: input.loop.blocker ?? "验证或修复已取消。" };
  }
  if (input.loop.outcome === "blocked" || input.loop.outcome === "incomplete") {
    return { status: input.loop.outcome, evidence, reason: input.loop.blocker ?? "修复闭环未完成。" };
  }
  if (input.loop.outcome !== "passed") {
    return { status: "incomplete", evidence, reason: "修复闭环仍在运行，不能请求完成。" };
  }

  assertPassedLoopEvidence(input.loop);
  const decision = evaluateAgentCompletion({
    evidence,
    finalContent: input.finalContent,
    recoveryAttempted: input.recoveryAttempted ?? false,
    editingToolsAvailable: input.editingToolsAvailable ?? true
  });
  return {
    status: decision.status === "completed" ? "completed" : decision.status === "blocked" ? "blocked" : "incomplete",
    evidence,
    reason: decision.reason,
    decision
  };
}
