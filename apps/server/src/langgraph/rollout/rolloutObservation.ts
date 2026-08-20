export type RolloutObservationMode = "legacy" | "all";

export type RolloutObservationMetrics = {
  taskCount: number;
  successRate: number;
  errorTerminalRate: number;
  unauthorizedWriteCount: number;
  scopeViolationCount: number;
  duplicateSideEffectCount: number;
  stateCorruptionCount: number;
  incorrectCompletionCount: number;
  restartRecoveryFailureCount: number;
  patchApprovalRate: number;
  patchApplySuccessRate: number;
  rollbackRate: number;
  validationSuccessRate: number;
  averageSteps: number;
  p95Steps: number;
  averageDurationMs: number;
  p95DurationMs: number;
  averageTokens: number;
  p95Tokens: number;
  toolRecoveryRate: number;
  duplicateToolCallRate: number;
  replanExhaustionRate: number;
  approvalRecoveryRate: number;
};

export type RolloutObservationCycle = {
  cycleId: string;
  mode: RolloutObservationMode;
  startedAt: string;
  endedAt: string;
  metrics: RolloutObservationMetrics;
};

export type RolloutObservationThresholds = {
  minimumTasksPerCycle: number;
  maximumSuccessRateDrop: number;
  maximumErrorTerminalRate: number;
  maximumP95DurationRatio: number;
  maximumP95TokenRatio: number;
};

export type RolloutObservationDecision = {
  action: "promote" | "hold" | "rollback";
  eligibleForLegacyCleanup: boolean;
  evaluatedCycleIds: string[];
  violations: string[];
};

export type RolloutObservationInput = {
  baseline: RolloutObservationCycle;
  cycles: RolloutObservationCycle[];
  thresholds: RolloutObservationThresholds;
};

const RATE_FIELDS: Array<keyof RolloutObservationMetrics> = [
  "successRate",
  "errorTerminalRate",
  "patchApprovalRate",
  "patchApplySuccessRate",
  "rollbackRate",
  "validationSuccessRate",
  "toolRecoveryRate",
  "duplicateToolCallRate",
  "replanExhaustionRate",
  "approvalRecoveryRate"
];

const NON_NEGATIVE_FIELDS: Array<keyof RolloutObservationMetrics> = [
  "taskCount",
  "unauthorizedWriteCount",
  "scopeViolationCount",
  "duplicateSideEffectCount",
  "stateCorruptionCount",
  "incorrectCompletionCount",
  "restartRecoveryFailureCount",
  "averageSteps",
  "p95Steps",
  "averageDurationMs",
  "p95DurationMs",
  "averageTokens",
  "p95Tokens"
];

const HARD_SAFETY_FIELDS: Array<keyof RolloutObservationMetrics> = [
  "unauthorizedWriteCount",
  "scopeViolationCount",
  "duplicateSideEffectCount",
  "stateCorruptionCount",
  "incorrectCompletionCount",
  "restartRecoveryFailureCount"
];

function validateMetrics(metrics: RolloutObservationMetrics) {
  const violations: string[] = [];
  for (const field of RATE_FIELDS) {
    const value = metrics[field];
    if (!Number.isFinite(value) || value < 0 || value > 1) violations.push(`invalid_metric:${field}`);
  }
  for (const field of NON_NEGATIVE_FIELDS) {
    const value = metrics[field];
    if (!Number.isFinite(value) || value < 0) violations.push(`invalid_metric:${field}`);
  }
  return violations;
}

function validateCycle(cycle: RolloutObservationCycle) {
  const violations = validateMetrics(cycle.metrics);
  const startedAt = Date.parse(cycle.startedAt);
  const endedAt = Date.parse(cycle.endedAt);
  if (!cycle.cycleId.trim()) violations.push("invalid_cycle:id");
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    violations.push("invalid_cycle:time_range");
  }
  return violations;
}

/**
 * 阶段 9 发布门禁只处理汇总指标，不接收 Prompt、源码、命令输出或用户内容。
 * 任意安全零容忍项或已批准性能阈值越界都会要求立即回退。
 */
export function evaluateRolloutObservation(input: RolloutObservationInput): RolloutObservationDecision {
  const cycles = [...input.cycles].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  const evaluatedCycleIds = cycles.map((cycle) => cycle.cycleId);
  const invalid = [
    ...validateCycle(input.baseline),
    ...cycles.flatMap(validateCycle)
  ];
  if (invalid.length) {
    return { action: "rollback", eligibleForLegacyCleanup: false, evaluatedCycleIds, violations: [...new Set(invalid)] };
  }

  const hardSafetyViolations = cycles.flatMap((cycle) => HARD_SAFETY_FIELDS
    .filter((field) => cycle.metrics[field] > 0)
    .map((field) => `hard_safety:${field}`));
  if (hardSafetyViolations.length) {
    return { action: "rollback", eligibleForLegacyCleanup: false, evaluatedCycleIds, violations: [...new Set(hardSafetyViolations)] };
  }

  const holdViolations: string[] = [];
  if (cycles.length < 2) holdViolations.push("observation:requires_two_cycles");
  if (cycles.some((cycle) => cycle.mode !== "all")) holdViolations.push("observation:requires_all_mode");
  if (new Set(evaluatedCycleIds).size !== evaluatedCycleIds.length) holdViolations.push("observation:duplicate_cycle_id");
  if (cycles.some((cycle) => cycle.metrics.taskCount < input.thresholds.minimumTasksPerCycle)) {
    holdViolations.push("observation:insufficient_sample");
  }
  if (holdViolations.length) {
    return { action: "hold", eligibleForLegacyCleanup: false, evaluatedCycleIds, violations: holdViolations };
  }

  const thresholdViolations: string[] = [];
  const minimumSuccessRate = input.baseline.metrics.successRate - input.thresholds.maximumSuccessRateDrop;
  for (const cycle of cycles) {
    if (cycle.metrics.successRate < minimumSuccessRate) thresholdViolations.push("threshold:success_rate");
    if (cycle.metrics.errorTerminalRate > input.thresholds.maximumErrorTerminalRate) thresholdViolations.push("threshold:error_terminal_rate");
    if (cycle.metrics.p95DurationMs > input.baseline.metrics.p95DurationMs * input.thresholds.maximumP95DurationRatio) {
      thresholdViolations.push("threshold:p95_duration");
    }
    if (cycle.metrics.p95Tokens > input.baseline.metrics.p95Tokens * input.thresholds.maximumP95TokenRatio) {
      thresholdViolations.push("threshold:p95_tokens");
    }
  }
  if (thresholdViolations.length) {
    return { action: "rollback", eligibleForLegacyCleanup: false, evaluatedCycleIds, violations: [...new Set(thresholdViolations)] };
  }

  return { action: "promote", eligibleForLegacyCleanup: true, evaluatedCycleIds, violations: [] };
}
