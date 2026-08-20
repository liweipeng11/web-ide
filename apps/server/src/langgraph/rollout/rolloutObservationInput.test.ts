import assert from "node:assert/strict";
import test from "node:test";
import { parseRolloutObservationDocument } from "./rolloutObservationInput.js";

function metrics() {
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
    approvalRecoveryRate: 1
  };
}

function cycle(cycleId: string, mode: "legacy" | "all") {
  return {
    cycleId,
    mode,
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-02T00:00:00.000Z",
    metrics: metrics()
  };
}

function document() {
  return {
    schemaVersion: 1,
    baseline: cycle("legacy-baseline", "legacy"),
    cycles: [cycle("all-1", "all"), cycle("all-2", "all")],
    thresholds: {
      minimumTasksPerCycle: 50,
      maximumSuccessRateDrop: 0.03,
      maximumErrorTerminalRate: 0.05,
      maximumP95DurationRatio: 1.25,
      maximumP95TokenRatio: 1.2
    }
  };
}

test("严格解析合法的阶段 9 聚合观察文档", () => {
  const parsed = parseRolloutObservationDocument(document());
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.baseline.mode, "legacy");
  assert.deepEqual(parsed.cycles.map((item) => item.cycleId), ["all-1", "all-2"]);
});

test("拒绝 Prompt、源码等未允许字段进入观察报告", () => {
  const input = document() as ReturnType<typeof document> & { prompt?: string };
  input.prompt = "敏感提示词";
  assert.throws(() => parseRolloutObservationDocument(input), /未允许字段/);

  const nested = document();
  Object.assign(nested.cycles[0]!.metrics, { sourceCode: "secret" });
  assert.throws(() => parseRolloutObservationDocument(nested), /未允许字段/);
});

test("拒绝伪装成 Legacy 的全量基线和非法指标", () => {
  const invalidBaseline = document();
  invalidBaseline.baseline.mode = "all";
  assert.throws(() => parseRolloutObservationDocument(invalidBaseline), /baseline\.mode/);

  const invalidRate = document();
  invalidRate.cycles[0]!.metrics.successRate = 1.1;
  assert.throws(() => parseRolloutObservationDocument(invalidRate), /0 到 1/);

  const invalidCount = document();
  invalidCount.cycles[0]!.metrics.taskCount = 1.5;
  assert.throws(() => parseRolloutObservationDocument(invalidCount), /必须是整数/);
});

test("拒绝未批准或无效的发布阈值", () => {
  const invalidSample = document();
  invalidSample.thresholds.minimumTasksPerCycle = 0;
  assert.throws(() => parseRolloutObservationDocument(invalidSample), /正整数/);

  const invalidRatio = document();
  invalidRatio.thresholds.maximumP95TokenRatio = 0;
  assert.throws(() => parseRolloutObservationDocument(invalidRatio), /P95 比率/);
});
