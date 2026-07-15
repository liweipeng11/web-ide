import test from "node:test";
import assert from "node:assert/strict";
import { runEvaluationSuite } from "./runner.js";

test("离线 Mock 评测覆盖十类场景并生成机器可读报告", async () => {
  const report = await runEvaluationSuite();
  assert.equal(report.provider, "mock");
  assert.equal(report.summary.total, 10);
  assert.equal(report.summary.passed, 10);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.cases.every((item) => item.result.metrics.schemaVersion === 1), true);
  assert.equal(report.cases.every((item) => item.result.metrics.scope === "task_run"), true);
  assert.equal(report.cases.every((item) => item.result.metrics.context.estimator === "conservative" && (item.result.metrics.context.estimatedTokensBefore ?? 0) > 0), true);
  assert.equal(report.cases.filter((item) => item.scenarioId !== "validation_retry").every((item) => typeof item.result.metrics.firstTokenLatencyMs === "number" && item.result.metrics.firstTokenLatencySource === "completion_upper_bound"), true);
  assert.equal(report.cases.find((item) => item.scenarioId === "validation_retry")?.result.metrics.firstTokenLatencySource, "unavailable");
  assert.equal(report.cases.find((item) => item.scenarioId === "approval_resume")?.result.metrics.tools.calls, 1);
  assert.equal(report.cases.find((item) => item.scenarioId === "cross_file_contract_change")?.result.metrics.result.patchFileCount, 2);
  assert.equal(report.cases.find((item) => item.scenarioId === "validation_retry")?.result.metrics.result.validationCommandCount, 2);
  assert.equal(report.cases.find((item) => item.scenarioId === "validation_retry")?.result.metrics.result.validationStatus, "passed");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(report)));
});
