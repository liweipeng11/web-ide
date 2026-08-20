import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateRolloutObservation,
  type RolloutObservationCycle,
  type RolloutObservationMetrics
} from "./rolloutObservation.js";

function metrics(overrides: Partial<RolloutObservationMetrics> = {}): RolloutObservationMetrics {
  return {
    taskCount: 100,
    successRate: 0.95,
    errorTerminalRate: 0.02,
    unauthorizedWriteCount: 0,
    scopeViolationCount: 0,
    duplicateSideEffectCount: 0,
    stateCorruptionCount: 0,
    incorrectCompletionCount: 0,
    restartRecoveryFailureCount: 0,
    patchApprovalRate: 0.8,
    patchApplySuccessRate: 0.98,
    rollbackRate: 0.01,
    validationSuccessRate: 0.94,
    averageSteps: 8,
    p95Steps: 15,
    averageDurationMs: 1_000,
    p95DurationMs: 2_000,
    averageTokens: 1_000,
    p95Tokens: 2_000,
    toolRecoveryRate: 0.9,
    duplicateToolCallRate: 0,
    replanExhaustionRate: 0.01,
    approvalRecoveryRate: 1,
    ...overrides
  };
}

function cycle(cycleId: string, mode: "legacy" | "all", overrides: Partial<RolloutObservationMetrics> = {}): RolloutObservationCycle {
  const day = cycleId.endsWith("2") ? "03" : "01";
  return {
    cycleId,
    mode,
    startedAt: `2026-08-${day}T00:00:00.000Z`,
    endedAt: `2026-08-${day}T23:59:59.000Z`,
    metrics: metrics(overrides)
  };
}

const thresholds = {
  minimumTasksPerCycle: 50,
  maximumSuccessRateDrop: 0.03,
  maximumErrorTerminalRate: 0.05,
  maximumP95DurationRatio: 1.25,
  maximumP95TokenRatio: 1.2
};

test("两轮 all 观察周期满足安全、正确性、性能和成本阈值后才允许清理 Legacy", () => {
  const decision = evaluateRolloutObservation({
    baseline: cycle("legacy", "legacy"),
    cycles: [cycle("all-1", "all", { successRate: 0.94 }), cycle("all-2", "all", { p95DurationMs: 2_400 })],
    thresholds
  });
  assert.deepEqual(decision, {
    action: "promote",
    eligibleForLegacyCleanup: true,
    evaluatedCycleIds: ["all-1", "all-2"],
    violations: []
  });
});

test("未审批写入等零容忍安全信号立即要求回退", () => {
  const decision = evaluateRolloutObservation({
    baseline: cycle("legacy", "legacy"),
    cycles: [cycle("all-1", "all"), cycle("all-2", "all", { unauthorizedWriteCount: 1 })],
    thresholds
  });
  assert.equal(decision.action, "rollback");
  assert.equal(decision.eligibleForLegacyCleanup, false);
  assert.deepEqual(decision.violations, ["hard_safety:unauthorizedWriteCount"]);
});

test("观察周期或样本不足保持 hold，不用测试夹具伪装生产稳定期", () => {
  const decision = evaluateRolloutObservation({
    baseline: cycle("legacy", "legacy"),
    cycles: [cycle("all-1", "all", { taskCount: 10 })],
    thresholds
  });
  assert.equal(decision.action, "hold");
  assert.deepEqual(decision.violations, ["observation:requires_two_cycles", "observation:insufficient_sample"]);
});

test("成功率、P95 延迟或 token 超过批准阈值时要求回退", () => {
  for (const override of [
    { successRate: 0.9 },
    { p95DurationMs: 2_600 },
    { p95Tokens: 2_500 }
  ]) {
    const decision = evaluateRolloutObservation({
      baseline: cycle("legacy", "legacy"),
      cycles: [cycle("all-1", "all"), cycle("all-2", "all", override)],
      thresholds
    });
    assert.equal(decision.action, "rollback");
  }
});

test("损坏或重复的观察周期不会放行阶段 10", () => {
  const duplicate = cycle("all-1", "all");
  const decision = evaluateRolloutObservation({
    baseline: cycle("legacy", "legacy"),
    cycles: [duplicate, { ...duplicate }],
    thresholds
  });
  assert.equal(decision.action, "hold");
  assert.equal(decision.eligibleForLegacyCleanup, false);
  assert.ok(decision.violations.includes("observation:duplicate_cycle_id"));
});
