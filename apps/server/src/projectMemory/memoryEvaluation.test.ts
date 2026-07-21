import assert from "node:assert/strict";
import test from "node:test";
import { runProjectMemoryEvaluation } from "./memoryEvaluation.js";

test("固定评测集达到阶段 6 的召回、安全、延迟和预算门槛", () => {
  const evaluation = runProjectMemoryEvaluation();
  assert.equal(evaluation.scenarios.length, 6);
  assert.ok(evaluation.metrics.recallAt5 >= 0.9, `Recall@5=${evaluation.metrics.recallAt5}`);
  assert.ok(evaluation.metrics.irrelevantInjectionRate <= 0.1);
  assert.equal(evaluation.metrics.staleInjectionRate, 0);
  assert.ok(evaluation.metrics.p95LatencyMs < 100, `P95=${evaluation.metrics.p95LatencyMs}ms`);
  assert.deepEqual(evaluation.safeguards, {
    promptInjectionBlocked: true,
    projectRulesPrecedence: true,
    currentWorkspacePrecedence: true,
    tokenBudgetPassed: true
  });
  assert.equal(evaluation.passed, true);
});

test("固定评测重复执行得到相同的质量结果", () => {
  const first = runProjectMemoryEvaluation();
  const second = runProjectMemoryEvaluation();
  assert.deepEqual(first.scenarios, second.scenarios);
  assert.deepEqual(
    { ...first.metrics, p95LatencyMs: 0 },
    { ...second.metrics, p95LatencyMs: 0 }
  );
});
