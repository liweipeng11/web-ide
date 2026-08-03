import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceCompletionRejectionState,
  createCompletionEvidenceFingerprint,
  createCompletionRejectionGuidance,
  evaluateAgentCompletion,
  finalContentClaimsIncomplete,
  finalContentHasNonRecoverableBlock,
  type CompletionEvidence
} from "./agentCompletionPolicy.js";

function createEvidence(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {
    workflowType: "feature",
    mutationExpected: true,
    generatedPatchCount: 0,
    changedFileCount: 0,
    pendingPlanCount: 0,
    blockedPlanCount: 0,
    validationStatus: "not_run",
    pendingApprovalCount: 0,
    activeCommandCount: 0,
    failedToolCallCount: 0,
    ...overrides
  };
}

test("编辑任务生成补丁后进入 awaiting_approval", () => {
  const decision = evaluateAgentCompletion({
    evidence: createEvidence({ generatedPatchCount: 1 }),
    finalContent: "已生成补丁。",
    recoveryAttempted: false,
    editingToolsAvailable: true
  });

  assert.equal(decision.status, "awaiting_approval");
  assert.equal(decision.shouldRecover, false);
});

test("文件已写入、验证通过且实现计划完成时才返回 completed", () => {
  const completed = evaluateAgentCompletion({
    evidence: createEvidence({ changedFileCount: 2, validationStatus: "passed" }),
    finalContent: "修改与验证均已完成。",
    recoveryAttempted: false,
    editingToolsAvailable: true
  });
  const pending = evaluateAgentCompletion({
    evidence: createEvidence({ changedFileCount: 2, pendingPlanCount: 1 }),
    finalContent: "代码已写入。",
    recoveryAttempted: false,
    editingToolsAvailable: true
  });

  assert.equal(completed.status, "completed");
  assert.equal(pending.status, "incomplete");
});

test("零补丁零变更先恢复一次，之后持久化 incomplete", () => {
  const first = evaluateAgentCompletion({
    evidence: createEvidence(),
    finalContent: "这里给出一段示例代码。",
    recoveryAttempted: false,
    editingToolsAvailable: true
  });
  const second = evaluateAgentCompletion({
    evidence: createEvidence(),
    finalContent: "这里给出一段示例代码。",
    recoveryAttempted: true,
    editingToolsAvailable: true
  });

  assert.equal(first.status, "incomplete");
  assert.equal(first.shouldRecover, true);
  assert.equal(second.status, "incomplete");
  assert.equal(second.shouldRecover, false);
});

test("只有用户选择、权限、外部状态或安全策略形成 blocked", () => {
  assert.equal(finalContentHasNonRecoverableBlock("需要您选择使用哪个数据库后才能继续。"), true);
  assert.equal(finalContentHasNonRecoverableBlock("当前没有生成补丁。"), false);

  const decision = evaluateAgentCompletion({
    evidence: createEvidence(),
    finalContent: "缺少仓库写入权限，无法继续。",
    recoveryAttempted: false,
    editingToolsAvailable: true
  });
  assert.equal(decision.status, "blocked");
});

test("最终文本自认未完成时不得 completed，分析任务不受编辑条件影响", () => {
  assert.equal(finalContentClaimsIncomplete("任务尚未完成，请手动修改。"), true);

  const editDecision = evaluateAgentCompletion({
    evidence: createEvidence({ changedFileCount: 1 }),
    finalContent: "任务尚未完成，请手动修改。",
    recoveryAttempted: true,
    editingToolsAvailable: true
  });
  const analysisDecision = evaluateAgentCompletion({
    evidence: createEvidence({ workflowType: "analysis-only", mutationExpected: false }),
    finalContent: "分析结论如下。",
    recoveryAttempted: false,
    editingToolsAvailable: false
  });

  assert.equal(editDecision.status, "incomplete");
  assert.equal(analysisDecision.status, "completed");
});

test("编辑后未验证或验证失败均不得 completed", () => {
  for (const validationStatus of ["not_run", "failed"] as const) {
    const decision = evaluateAgentCompletion({
      evidence: createEvidence({ changedFileCount: 1, validationStatus }),
      finalContent: "修改完成。",
      recoveryAttempted: true,
      editingToolsAvailable: true
    });
    assert.equal(decision.status, "incomplete");
  }
});

test("等待审批、运行中命令和失败工具调用分别阻止完成", () => {
  const cases = [
    { overrides: { pendingApprovalCount: 1 }, expected: "awaiting_approval" },
    { overrides: { activeCommandCount: 1 }, expected: "incomplete" },
    { overrides: { failedToolCallCount: 1 }, expected: "incomplete" }
  ] as const;

  for (const item of cases) {
    const decision = evaluateAgentCompletion({
      evidence: createEvidence({ changedFileCount: 1, validationStatus: "passed", ...item.overrides }),
      finalContent: "修改与验证均已完成。",
      recoveryAttempted: true,
      editingToolsAvailable: true
    });
    assert.equal(decision.status, item.expected);
  }
});

test("验证早于最后变更时要求重新验证，验证能力不可用时允许明确降级", () => {
  const stale = evaluateAgentCompletion({
    evidence: createEvidence({ changedFileCount: 1, validationStatus: "passed", lastValidationAt: 10, lastMutationAt: 20 }),
    finalContent: "修改完成。",
    recoveryAttempted: true,
    editingToolsAvailable: true
  });
  const unavailable = evaluateAgentCompletion({
    evidence: createEvidence({ changedFileCount: 1, validationStatus: "unavailable", lastMutationAt: 20 }),
    finalContent: "修改完成；验证环境不可用，已记录降级证据。",
    recoveryAttempted: true,
    editingToolsAvailable: true
  });

  assert.equal(stale.status, "incomplete");
  assert.equal(unavailable.status, "completed");
});

test("每类未完成证据都返回稳定拒绝码和建议动作", () => {
  const cases: Array<{
    overrides: Partial<CompletionEvidence>;
    finalContent?: string;
    expectedCode: string;
  }> = [
    { overrides: {}, expectedCode: "NO_MUTATION_EVIDENCE" },
    { overrides: { changedFileCount: 1 }, expectedCode: "VALIDATION_NOT_RUN" },
    { overrides: { changedFileCount: 1, validationStatus: "failed" }, expectedCode: "VALIDATION_FAILED" },
    { overrides: { changedFileCount: 1, validationStatus: "passed", lastMutationAt: 20, lastValidationAt: 10 }, expectedCode: "VALIDATION_STALE" },
    { overrides: { changedFileCount: 1, validationStatus: "passed", activeCommandCount: 1 }, expectedCode: "ACTIVE_COMMAND" },
    { overrides: { changedFileCount: 1, validationStatus: "passed", failedToolCallCount: 1 }, expectedCode: "FAILED_TOOL_CALL" },
    { overrides: { changedFileCount: 1, validationStatus: "passed", pendingPlanCount: 1 }, expectedCode: "PENDING_PLAN" },
    { overrides: { changedFileCount: 1, validationStatus: "passed" }, finalContent: "任务尚未完成。", expectedCode: "INCOMPLETE_CLAIM" }
  ];

  for (const item of cases) {
    const decision = evaluateAgentCompletion({
      evidence: createEvidence(item.overrides),
      finalContent: item.finalContent ?? "修改完成。",
      recoveryAttempted: false,
      editingToolsAvailable: true
    });
    assert.equal(decision.code, item.expectedCode);
    assert.ok(decision.reason);
    assert.ok(decision.suggestedAction);
  }
});

test("构建通过但恢复证据丢失时返回面向用户的根因说明", () => {
  const decision = evaluateAgentCompletion({
    evidence: createEvidence({ validationStatus: "passed" }),
    finalContent: "修改和构建均已完成。",
    recoveryAttempted: true,
    editingToolsAvailable: true
  });

  assert.equal(decision.code, "NO_MUTATION_EVIDENCE");
  assert.equal(decision.reason, "构建已经通过，但当前恢复运行缺少文件变更证据。");
});

test("完成证据指纹稳定且不依赖模型 summary", () => {
  const evidence = createEvidence({
    changedFileCount: 1,
    validationStatus: "passed",
    lastMutationAt: 10,
    lastValidationAt: 20
  });

  const first = createCompletionEvidenceFingerprint(evidence);
  const second = createCompletionEvidenceFingerprint({ ...evidence });
  assert.equal(first, second);
  assert.equal(first.includes("summary"), false);
});

test("相同证据连续计数，理由文本不能绕过限制，证据变化会重置", () => {
  const evidence = createEvidence();
  const first = advanceCompletionRejectionState(undefined, evidence, "NO_MUTATION_EVIDENCE");
  const second = advanceCompletionRejectionState(first, evidence, "NO_MUTATION_EVIDENCE");
  const evidenceChanged = advanceCompletionRejectionState(second, { ...evidence, changedFileCount: 1 }, "VALIDATION_NOT_RUN");
  const reasonChanged = advanceCompletionRejectionState(second, evidence, "VALIDATION_FAILED");

  assert.equal(first.consecutiveCount, 1);
  assert.equal(second.consecutiveCount, 2);
  assert.equal(evidenceChanged.consecutiveCount, 1);
  assert.equal(reasonChanged.consecutiveCount, 3);
  assert.equal(reasonChanged.rejectionCode, "VALIDATION_FAILED");
  assert.match(createCompletionRejectionGuidance({
    status: "incomplete",
    code: "NO_MUTATION_EVIDENCE",
    reason: "缺少变更",
    suggestedAction: "执行文件编辑。",
    shouldRecover: true
  }, 2), /禁止再次直接调用 completeTask/);
});
