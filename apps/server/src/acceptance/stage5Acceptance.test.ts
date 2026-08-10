import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluationSuite } from "../evaluation/index.js";
import { runStage5Acceptance, stage5FeatureNames, stage5MinimumCompletionRate } from "./stage5Acceptance.js";

test("阶段 5 验收覆盖默认启用、显式回退和十类集成场景", async () => {
  const report = await runStage5Acceptance();

  assert.equal(report.stage, 5);
  assert.equal(report.threshold, 90);
  const featureCount = stage5FeatureNames.length;
  assert.equal(report.checks.filter((item) => item.category === "default_activation").length, featureCount);
  assert.equal(report.checks.filter((item) => item.category === "rollback").length, featureCount);
  assert.equal(report.checks.filter((item) => item.category === "integration_scenario").length, 10);
  assert.equal(report.summary.total, featureCount * 2 + 10);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.completionRate, 100);
  assert.equal(report.accepted, true);
});

test("完成度低于 90% 时拒绝通过阶段 5 验收", async () => {
  const evaluation = await runEvaluationSuite();
  const totalCheckCount = stage5FeatureNames.length * 2 + evaluation.cases.length;
  // 随功能矩阵扩展动态制造足够的失败项，确保样本完成度始终严格低于验收阈值。
  const failedCaseCount = Math.floor(totalCheckCount * (1 - stage5MinimumCompletionRate / 100)) + 1;
  const failedEvaluation = {
    ...evaluation,
    summary: { ...evaluation.summary, passed: evaluation.summary.total - failedCaseCount, failed: failedCaseCount, successRate: 70 },
    cases: evaluation.cases.map((item, index) => index < failedCaseCount ? { ...item, passed: false, failures: ["模拟集成失败"] } : item)
  };
  const report = await runStage5Acceptance({ evaluation: failedEvaluation });

  assert.equal(report.summary.completionRate < stage5MinimumCompletionRate, true);
  assert.equal(report.accepted, false);
});
