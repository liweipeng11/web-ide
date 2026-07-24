import assert from "node:assert/strict";
import test from "node:test";
import {
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
    validationAttempted: false,
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

test("文件已写入且实现计划完成时才返回 completed", () => {
  const completed = evaluateAgentCompletion({
    evidence: createEvidence({ changedFileCount: 2, validationAttempted: true }),
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
