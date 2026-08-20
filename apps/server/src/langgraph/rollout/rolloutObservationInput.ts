import type {
  RolloutObservationCycle,
  RolloutObservationInput,
  RolloutObservationMetrics,
  RolloutObservationThresholds
} from "./rolloutObservation.js";

export type RolloutObservationDocument = RolloutObservationInput & { schemaVersion: 1 };

const METRIC_FIELDS = [
  "taskCount", "successRate", "errorTerminalRate", "unauthorizedWriteCount", "scopeViolationCount",
  "duplicateSideEffectCount", "stateCorruptionCount", "incorrectCompletionCount", "restartRecoveryFailureCount",
  "patchApprovalRate", "patchApplySuccessRate", "rollbackRate", "validationSuccessRate", "averageSteps", "p95Steps",
  "averageDurationMs", "p95DurationMs", "averageTokens", "p95Tokens", "toolRecoveryRate", "duplicateToolCallRate",
  "replanExhaustionRate", "approvalRecoveryRate"
] as const satisfies readonly (keyof RolloutObservationMetrics)[];

const RATE_FIELDS = new Set<keyof RolloutObservationMetrics>([
  "successRate", "errorTerminalRate", "patchApprovalRate", "patchApplySuccessRate", "rollbackRate",
  "validationSuccessRate", "toolRecoveryRate", "duplicateToolCallRate", "replanExhaustionRate", "approvalRecoveryRate"
]);

const INTEGER_FIELDS = new Set<keyof RolloutObservationMetrics>([
  "taskCount", "unauthorizedWriteCount", "scopeViolationCount", "duplicateSideEffectCount", "stateCorruptionCount",
  "incorrectCompletionCount", "restartRecoveryFailureCount"
]);

const THRESHOLD_FIELDS = [
  "minimumTasksPerCycle", "maximumSuccessRateDrop", "maximumErrorTerminalRate",
  "maximumP95DurationRatio", "maximumP95TokenRatio"
] as const satisfies readonly (keyof RolloutObservationThresholds)[];

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unknown.length) throw new Error(`${path} 包含未允许字段：${unknown.join(", ")}`);
  if (missing.length) throw new Error(`${path} 缺少字段：${missing.join(", ")}`);
}

function finiteNumber(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} 必须是有限数字`);
  return value;
}

function parseMetrics(value: unknown, path: string): RolloutObservationMetrics {
  const source = record(value, path);
  exactKeys(source, METRIC_FIELDS, path);
  const parsed = {} as RolloutObservationMetrics;
  for (const field of METRIC_FIELDS) {
    const metric = finiteNumber(source[field], `${path}.${field}`);
    if (metric < 0) throw new Error(`${path}.${field} 不能为负数`);
    if (RATE_FIELDS.has(field) && metric > 1) throw new Error(`${path}.${field} 必须位于 0 到 1 之间`);
    if (INTEGER_FIELDS.has(field) && !Number.isInteger(metric)) throw new Error(`${path}.${field} 必须是整数`);
    parsed[field] = metric;
  }
  return parsed;
}

function parseCycle(value: unknown, path: string): RolloutObservationCycle {
  const source = record(value, path);
  exactKeys(source, ["cycleId", "mode", "startedAt", "endedAt", "metrics"], path);
  if (typeof source.cycleId !== "string" || !source.cycleId.trim()) throw new Error(`${path}.cycleId 必须是非空字符串`);
  if (source.mode !== "legacy" && source.mode !== "all") throw new Error(`${path}.mode 只允许 legacy 或 all`);
  if (typeof source.startedAt !== "string" || typeof source.endedAt !== "string") {
    throw new Error(`${path} 的 startedAt 和 endedAt 必须是 ISO 时间字符串`);
  }
  return {
    cycleId: source.cycleId,
    mode: source.mode,
    startedAt: source.startedAt,
    endedAt: source.endedAt,
    metrics: parseMetrics(source.metrics, `${path}.metrics`)
  };
}

function parseThresholds(value: unknown): RolloutObservationThresholds {
  const source = record(value, "thresholds");
  exactKeys(source, THRESHOLD_FIELDS, "thresholds");
  const parsed = Object.fromEntries(THRESHOLD_FIELDS.map((field) => [field, finiteNumber(source[field], `thresholds.${field}`)])) as RolloutObservationThresholds;
  if (!Number.isInteger(parsed.minimumTasksPerCycle) || parsed.minimumTasksPerCycle <= 0) {
    throw new Error("thresholds.minimumTasksPerCycle 必须是正整数");
  }
  if (parsed.maximumSuccessRateDrop < 0 || parsed.maximumSuccessRateDrop > 1) {
    throw new Error("thresholds.maximumSuccessRateDrop 必须位于 0 到 1 之间");
  }
  if (parsed.maximumErrorTerminalRate < 0 || parsed.maximumErrorTerminalRate > 1) {
    throw new Error("thresholds.maximumErrorTerminalRate 必须位于 0 到 1 之间");
  }
  if (parsed.maximumP95DurationRatio <= 0 || parsed.maximumP95TokenRatio <= 0) {
    throw new Error("P95 比率阈值必须大于 0");
  }
  return parsed;
}

/** 严格解析运维聚合数据，未知字段会被拒绝，避免把业务内容带入发布报告。 */
export function parseRolloutObservationDocument(value: unknown): RolloutObservationDocument {
  const source = record(value, "document");
  exactKeys(source, ["schemaVersion", "baseline", "cycles", "thresholds"], "document");
  if (source.schemaVersion !== 1) throw new Error("document.schemaVersion 只支持 1");
  if (!Array.isArray(source.cycles)) throw new Error("document.cycles 必须是数组");
  const baseline = parseCycle(source.baseline, "baseline");
  if (baseline.mode !== "legacy") throw new Error("baseline.mode 必须是 legacy");
  return {
    schemaVersion: 1,
    baseline,
    cycles: source.cycles.map((cycle, index) => parseCycle(cycle, `cycles[${index}]`)),
    thresholds: parseThresholds(source.thresholds)
  };
}
