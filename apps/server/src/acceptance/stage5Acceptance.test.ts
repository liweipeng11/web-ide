import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluationSuite } from "../evaluation/index.js";
import { runStage5Acceptance, stage5MinimumCompletionRate } from "./stage5Acceptance.js";

test("阶段 5 验收覆盖默认启用、显式回退和十类集成场景", async () => {
  const report = await runStage5Acceptance();

  assert.equal(report.stage, 5);
  assert.equal(report.threshold, 90);
  assert.equal(report.checks.filter((item) => item.category === "default_activation").length, 5);
  assert.equal(report.checks.filter((item) => item.category === "rollback").length, 5);
  assert.equal(report.checks.filter((item) => item.category === "integration_scenario").length, 10);
  assert.equal(report.summary.total, 20);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.completionRate, 100);
  assert.equal(report.accepted, true);
});

test("完成度低于 90% 时拒绝通过阶段 5 验收", async () => {
  const evaluation = await runEvaluationSuite();
  const failedCaseCount = 3;
  const failedEvaluation = {
    ...evaluation,
    summary: { ...evaluation.summary, passed: evaluation.summary.total - failedCaseCount, failed: failedCaseCount, successRate: 70 },
    cases: evaluation.cases.map((item, index) => index < failedCaseCount ? { ...item, passed: false, failures: ["模拟集成失败"] } : item)
  };
  const report = await runStage5Acceptance({ evaluation: failedEvaluation });

  assert.equal(report.summary.completionRate < stage5MinimumCompletionRate, true);
  assert.equal(report.accepted, false);
});
