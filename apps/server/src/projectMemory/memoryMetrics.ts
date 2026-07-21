import type { ProjectMemory, ScoredProjectMemoryItem } from "./types.js";

const MAX_SAMPLES = 2_000;

type MetricsState = {
  candidatesCreated: number;
  candidatesAccepted: number;
  candidatesRejected: number;
  retrievals: number;
  retrievedItems: number;
  actuallyUsedItems: number;
  validationChecks: number;
  validationSuccesses: number;
  taskCompletions: number;
  memoryRelatedRepairs: number;
  retrievalLatenciesMs: number[];
  relevanceScores: number[];
  injectedTokens: number[];
  staleRatios: number[];
};

function initialState(): MetricsState {
  return {
    candidatesCreated: 0,
    candidatesAccepted: 0,
    candidatesRejected: 0,
    retrievals: 0,
    retrievedItems: 0,
    actuallyUsedItems: 0,
    validationChecks: 0,
    validationSuccesses: 0,
    taskCompletions: 0,
    memoryRelatedRepairs: 0,
    retrievalLatenciesMs: [],
    relevanceScores: [],
    injectedTokens: [],
    staleRatios: []
  };
}

let state = initialState();

function appendSample(samples: number[], value: number) {
  samples.push(Number.isFinite(value) ? value : 0);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], percentileValue: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)] ?? 0;
}

/** 指标只接收计数、分数和耗时，永远不接收或保存 Memory 正文。 */
export function recordMemoryCandidateMetric(outcome: "created" | "accepted" | "rejected") {
  if (outcome === "created") state.candidatesCreated += 1;
  if (outcome === "accepted") state.candidatesAccepted += 1;
  if (outcome === "rejected") state.candidatesRejected += 1;
}

export function recordMemoryValidationMetric(valid: number, total: number, memory: ProjectMemory) {
  state.validationChecks += Math.max(0, total);
  state.validationSuccesses += Math.max(0, valid);
  const staleCount = memory.items.filter((item) => item.status === "stale" || item.validationStatus === "possibly_stale" || item.validationStatus === "invalid").length;
  appendSample(state.staleRatios, ratio(staleCount, memory.items.length));
}

export function recordMemoryRetrievalMetric(input: {
  latencyMs: number;
  estimatedTokens: number;
  selectedItems: ScoredProjectMemoryItem[];
}) {
  state.retrievals += 1;
  state.retrievedItems += input.selectedItems.length;
  state.actuallyUsedItems += input.selectedItems.length;
  appendSample(state.retrievalLatenciesMs, input.latencyMs);
  appendSample(state.injectedTokens, input.estimatedTokens);
  input.selectedItems.forEach((entry) => appendSample(state.relevanceScores, entry.score));
}

export function recordMemoryTaskOutcome(repairedBecauseOfMemory: boolean) {
  state.taskCompletions += 1;
  if (repairedBecauseOfMemory) state.memoryRelatedRepairs += 1;
}

export function getMemoryMetricsSnapshot() {
  const decided = state.candidatesAccepted + state.candidatesRejected;
  return {
    candidates: {
      created: state.candidatesCreated,
      accepted: state.candidatesAccepted,
      rejected: state.candidatesRejected,
      acceptanceRate: ratio(state.candidatesAccepted, decided),
      rejectionRate: ratio(state.candidatesRejected, decided)
    },
    retrieval: {
      count: state.retrievals,
      averageItems: ratio(state.retrievedItems, state.retrievals),
      averageRelevanceScore: average(state.relevanceScores),
      averageInjectedTokens: average(state.injectedTokens),
      p95LatencyMs: percentile(state.retrievalLatenciesMs, 0.95),
      actualUsageFrequency: ratio(state.actuallyUsedItems, state.retrievedItems)
    },
    validation: {
      checks: state.validationChecks,
      successRate: ratio(state.validationSuccesses, state.validationChecks),
      averageStaleRatio: average(state.staleRatios)
    },
    tasks: {
      completions: state.taskCompletions,
      memoryRelatedRepairRate: ratio(state.memoryRelatedRepairs, state.taskCompletions)
    }
  };
}

export function resetMemoryMetrics() {
  state = initialState();
}
