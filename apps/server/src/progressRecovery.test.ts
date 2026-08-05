import test from "node:test";
import assert from "node:assert/strict";
import { decideRecovery, evaluateProgress } from "./progressRecovery.js";

const snapshot = (overrides = {}) => ({ discoveredFiles: 0, filesRead: 0, searchResults: 0, negativeEvidence: 0, generatedPatches: 0, modifiedFiles: 0, commandsRun: 0, completedWorkflowSteps: 0, ...overrides });

test("进展判定识别新文件、负面证据、补丁、验证与工作流推进", () => {
  const result = evaluateProgress(snapshot(), snapshot({ discoveredFiles: 1, negativeEvidence: 1, generatedPatches: 1, commandsRun: 1, completedWorkflowSteps: 1 }));
  assert.equal(result.progressed, true);
  assert.equal(result.vector.discoveredFiles, true);
  assert.equal(result.vector.negativeEvidence, true);
  assert.equal(result.vector.generatedPatches, true);
  assert.equal(result.vector.validationResults, true);
  assert.equal(result.vector.workflowAdvanced, true);
});

test("无结构化证据增量不会被误判为进展", () => {
  assert.equal(evaluateProgress(snapshot(), snapshot()).progressed, false);
});

test("恢复决策只对明确可重试错误进行有上限且按签名去重的重试", () => {
  const decision = decideRecovery({ consecutiveNoProgressSteps: 2, maxNoProgressSteps: 2, recoveryAttempts: 0, allowedRecoveryAttempts: 1, remainingSteps: 8, hasDeliverable: false, pendingPlanCount: 1, lastFailure: { errorCategory: "transient", retryable: true } });
  assert.equal(decision.action, "retry_transient");
  const exhausted = decideRecovery({ consecutiveNoProgressSteps: 2, maxNoProgressSteps: 2, recoveryAttempts: 0, allowedRecoveryAttempts: 1, remainingSteps: 8, hasDeliverable: false, pendingPlanCount: 1, sameFailureRetryCount: 1, activeDeliveryUnit: { version: 1, id: "unit-1", title: "修改服务", sourcePlanItemIds: ["plan-1"], status: "active", completionCriteria: [], candidateFiles: [], filesRead: [], plannedFiles: [], dependencyUnitIds: [], checkpointIds: [], verificationCommands: [], createdAt: 1, updatedAt: 1 }, lastFailure: { errorCategory: "transient", retryable: true } });
  assert.equal(exhausted.action, "switch_strategy");
});

test("权限与内部错误分别等待用户和可靠失败", () => {
  const common = { consecutiveNoProgressSteps: 2, maxNoProgressSteps: 2, recoveryAttempts: 1, allowedRecoveryAttempts: 1, remainingSteps: 3, hasDeliverable: false, pendingPlanCount: 0 };
  assert.equal(decideRecovery({ ...common, lastFailure: { errorCategory: "permission", retryable: false } }).action, "await_user");
  assert.equal(decideRecovery({ ...common, lastFailure: { errorCategory: "internal", retryable: false } }).action, "fail");
});
