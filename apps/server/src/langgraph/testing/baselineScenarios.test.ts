import test from "node:test";
import assert from "node:assert/strict";
import { baselineScenarios, getBaselineScenario } from "./baselineScenarios.js";
import { FakeModel } from "./fakeModel.js";
import { normalizeBaselineResult } from "./resultNormalizer.js";

test("阶段 0 基线场景完整覆盖迁移计划规定的行为", () => {
  assert.equal(baselineScenarios.length, 14);
  assert.equal(new Set(baselineScenarios.map((item) => item.kind)).size, 14);
  assert.equal(getBaselineScenario("unauthorized-write").expectedOutcome, "rejected");
  assert.throws(() => getBaselineScenario("missing"), /未知基线场景/);
});

test("Fake Model 返回固定响应且不会共享可变对象", async () => {
  const model = new FakeModel({ question: { text: "固定答案", signals: ["answer"], usage: { inputTokens: 1, outputTokens: 2 } } });
  const first = await model.complete({ scenarioId: "question" });
  first.usage!.inputTokens = 99;
  const second = await model.complete({ scenarioId: "question" });
  assert.equal(second.usage!.inputTokens, 1);
  await assert.rejects(model.complete({ scenarioId: "missing" }), /未配置场景响应/);
});

test("结果归一化移除波动字段、去重排序信号并保留稳定元数据", () => {
  assert.deepEqual(normalizeBaselineResult({
    scenarioId: "question",
    outcome: "completed",
    signals: ["answer", "answer", "read_only"],
    metadata: { runId: "volatile", durationMs: 12, stable: true, attempt: 1 }
  }), {
    scenarioId: "question",
    outcome: "completed",
    signals: ["answer", "read_only"],
    metadata: { attempt: 1, stable: true }
  });
});
