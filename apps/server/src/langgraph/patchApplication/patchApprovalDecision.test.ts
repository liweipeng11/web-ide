import assert from "node:assert/strict";
import test from "node:test";
import type { DeveloperPatchProposalReference } from "../developer/developerGraphState.js";
import type { PendingPatch } from "../../types.js";
import { expirePatchApproval, patchApprovalAgentStep, resolvePatchApproval } from "./patchApprovalDecision.js";
import { createPatchApprovalState } from "./patchApprovalState.js";

function fixture(overrides: Partial<PendingPatch> = {}) {
  const proposal: DeveloperPatchProposalReference = {
    patchId: "patch-abc",
    actionId: "graph-action-proposal",
    taskId: "I1",
    graphRunId: "run-1",
    filePaths: ["src/index.ts"]
  };
  const patch: PendingPatch = {
    patchId: proposal.patchId,
    taskSessionId: "session-1",
    files: [{
      path: "src/index.ts",
      filePath: "src/index.ts",
      status: "modify",
      oldContent: "before",
      newContent: "after",
      summary: "更新入口",
      diffHtml: "diff"
    }],
    source: {
      kind: "langgraph_developer",
      taskId: proposal.taskId,
      graphRunId: proposal.graphRunId,
      actionId: proposal.actionId,
      evidenceIds: ["existence", "impact"]
    },
    createdAt: 1,
    ...overrides
  };
  return { patch, proposal };
}

test("相同 Patch 来源稳定生成审批和应用 action ID", () => {
  const { patch, proposal } = fixture();
  const first = createPatchApprovalState({ taskSessionId: "session-1", patch, proposal, requestedAt: 100, expiresAt: 200 });
  const replay = createPatchApprovalState({ taskSessionId: "session-1", patch, proposal, requestedAt: 100, expiresAt: 200 });

  assert.equal(replay.approvalActionId, first.approvalActionId);
  assert.equal(replay.applyActionId, first.applyActionId);
  assert.notEqual(first.approvalActionId, first.applyActionId);
});

test("批准只更新决策状态且重复批准安全重放", () => {
  const { patch, proposal } = fixture();
  const pending = createPatchApprovalState({ taskSessionId: "session-1", patch, proposal, requestedAt: 100, expiresAt: 300 });
  const first = resolvePatchApproval(pending, { actionId: pending.approvalActionId, decision: "approved", decidedAt: 200 });
  const replay = resolvePatchApproval(first.state, { actionId: pending.approvalActionId, decision: "approved", decidedAt: 250 });

  assert.equal(first.state.status, "approved");
  assert.equal(first.state.resolutionSource, "user");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.state.decidedAt, 200);
  assert.equal("checkpointId" in replay.state, false);
});

test("审批终态拒绝相反决定和错误 action ID", () => {
  const { patch, proposal } = fixture();
  const pending = createPatchApprovalState({ taskSessionId: "session-1", patch, proposal, requestedAt: 100, expiresAt: 300 });
  const approved = resolvePatchApproval(pending, { actionId: pending.approvalActionId, decision: "approved", decidedAt: 200 }).state;

  assert.throws(
    () => resolvePatchApproval(approved, { actionId: pending.approvalActionId, decision: "rejected", decidedAt: 210 }),
    /不能改为 rejected/
  );
  assert.throws(
    () => resolvePatchApproval(pending, { actionId: "forged", decision: "approved", decidedAt: 200 }),
    /actionId 不匹配/
  );
});

test("超时和迟到批准都保持 expired 且不进入批准状态", () => {
  const { patch, proposal } = fixture();
  const pending = createPatchApprovalState({ taskSessionId: "session-1", patch, proposal, requestedAt: 100, expiresAt: 200 });
  const expired = expirePatchApproval(pending, 200);
  const lateApproval = resolvePatchApproval(expired.state, {
    actionId: pending.approvalActionId,
    decision: "approved",
    decidedAt: 220
  });

  assert.equal(expired.state.status, "expired");
  assert.equal(expired.state.resolutionSource, "timeout");
  assert.equal(lateApproval.state.status, "expired");
  assert.equal(lateApproval.replayed, true);
});

test("Patch、TaskSession、Graph 来源或文件集合不一致时拒绝创建审批", () => {
  const { patch, proposal } = fixture();
  assert.throws(
    () => createPatchApprovalState({ taskSessionId: "other-session", patch, proposal }),
    /TaskSession 不匹配/
  );
  assert.throws(
    () => createPatchApprovalState({
      taskSessionId: "session-1",
      patch,
      proposal: { ...proposal, graphRunId: "forged-run" }
    }),
    /来源不一致/
  );
  assert.throws(
    () => createPatchApprovalState({
      taskSessionId: "session-1",
      patch,
      proposal: { ...proposal, filePaths: ["src/other.ts"] }
    }),
    /文件集合.*不一致/
  );
});

test("审批状态映射到现有高风险 apply_patch AgentStep 且不泄漏正文", () => {
  const { patch, proposal } = fixture();
  const state = createPatchApprovalState({ taskSessionId: "session-1", patch, proposal, requestedAt: 100, expiresAt: 200 });
  const step = patchApprovalAgentStep(state);

  assert.equal(step.type, "approval_request");
  if (step.type !== "approval_request") return;
  assert.equal(step.actionId, state.approvalActionId);
  assert.equal(step.actionType, "apply_patch");
  assert.equal(step.riskLevel, "high");
  assert.deepEqual(step.targets, ["src/index.ts"]);
  assert.doesNotMatch(JSON.stringify(step), /before|after/);
});

