import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMemoryV3Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import {
  getMemoryMetricsSnapshot,
  recordMemoryCandidateMetric,
  recordMemoryRetrievalMetric,
  recordMemoryTaskOutcome,
  recordMemoryValidationMetric,
  resetMemoryMetrics
} from "./memoryMetrics.js";

test("聚合指标计算接受率、召回、验证、P95 和回修率", () => {
  resetMemoryMetrics();
  recordMemoryCandidateMetric("created");
  recordMemoryCandidateMetric("created");
  recordMemoryCandidateMetric("accepted");
  recordMemoryCandidateMetric("rejected");
  const memory = createProjectMemoryV3Fixture();
  const selectedItems = [{ item: memory.items[0]!, score: 80, reasons: ["request:test"] }];
  recordMemoryRetrievalMetric({ latencyMs: 5, estimatedTokens: 100, selectedItems });
  recordMemoryRetrievalMetric({ latencyMs: 20, estimatedTokens: 200, selectedItems });
  recordMemoryValidationMetric(3, 4, memory);
  recordMemoryTaskOutcome(false);
  recordMemoryTaskOutcome(true);

  const snapshot = getMemoryMetricsSnapshot();
  assert.deepEqual(snapshot.candidates, { created: 2, accepted: 1, rejected: 1, acceptanceRate: 0.5, rejectionRate: 0.5 });
  assert.equal(snapshot.retrieval.count, 2);
  assert.equal(snapshot.retrieval.averageItems, 1);
  assert.equal(snapshot.retrieval.averageRelevanceScore, 80);
  assert.equal(snapshot.retrieval.averageInjectedTokens, 150);
  assert.equal(snapshot.retrieval.p95LatencyMs, 20);
  assert.equal(snapshot.validation.successRate, 0.75);
  assert.equal(snapshot.tasks.memoryRelatedRepairRate, 0.5);
});

test("指标快照不包含 Memory 正文或来源", () => {
  const serialized = JSON.stringify(getMemoryMetricsSnapshot());
  assert.doesNotMatch(serialized, /content|sourceRefs|API_KEY/);
});
