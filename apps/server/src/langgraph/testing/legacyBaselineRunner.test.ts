import assert from "node:assert/strict";
import test from "node:test";
import { baselineScenarios, type BaselineScenario } from "./baselineScenarios.js";
import { FakeModel } from "./fakeModel.js";
import { runLegacyBaselineSuite, type LegacyBaselineExecutor } from "./legacyBaselineRunner.js";

function createFixture() {
  const model = new FakeModel(Object.fromEntries(baselineScenarios.map((scenario) => [
    scenario.id,
    { text: `固定响应：${scenario.id}`, signals: scenario.expectedSignals, usage: { inputTokens: 2, outputTokens: 1 } }
  ])));
  const execute: LegacyBaselineExecutor = async (scenario, context) => {
    const response = await context.model.complete({ scenarioId: scenario.id });
    return {
      scenarioId: scenario.id,
      outcome: scenario.expectedOutcome,
      signals: [...(response.signals ?? []), "legacy_runtime"],
      message: response.text,
      metadata: {
        provider: "fake",
        inputTokens: response.usage?.inputTokens ?? 0,
        runId: `run-${scenario.id}`,
        durationMs: Math.random()
      }
    };
  };
  return { model, execute };
}

test("Legacy Runner 覆盖全部场景并连续生成相同的归一化报告", async () => {
  const fixture = createFixture();
  const first = await runLegacyBaselineSuite({ scenarios: baselineScenarios, ...fixture });
  const second = await runLegacyBaselineSuite({ scenarios: baselineScenarios, ...fixture });

  assert.equal(first.cases.length, 14);
  assert.deepEqual(first, second);
  assert.equal(first.cases[0]?.result.metadata?.provider, "fake");
  assert.equal("runId" in (first.cases[0]?.result.metadata ?? {}), false);
});

test("Legacy Runner 拒绝场景 ID、终态或关键行为信号不一致的结果", async (context) => {
  const scenario = baselineScenarios[0] as BaselineScenario;
  const { model } = createFixture();

  await context.test("场景 ID 不一致", async () => {
    await assert.rejects(runLegacyBaselineSuite({
      scenarios: [scenario],
      model,
      execute: async () => ({ scenarioId: "other", outcome: "completed", signals: ["answer"] })
    }), /场景不匹配/);
  });

  await context.test("终态不一致", async () => {
    await assert.rejects(runLegacyBaselineSuite({
      scenarios: [scenario],
      model,
      execute: async () => ({ scenarioId: scenario.id, outcome: "failed", signals: ["answer"] })
    }), /终态不匹配/);
  });

  await context.test("缺少预期信号", async () => {
    await assert.rejects(runLegacyBaselineSuite({
      scenarios: [scenario],
      model,
      execute: async () => ({ scenarioId: scenario.id, outcome: "completed", signals: [] })
    }), /缺少预期信号：answer/);
  });
});

test("Legacy Runner 拒绝重复场景 ID，避免快照被后项覆盖", async () => {
  const fixture = createFixture();
  await assert.rejects(runLegacyBaselineSuite({
    scenarios: [baselineScenarios[0]!, baselineScenarios[0]!],
    ...fixture
  }), /场景 ID 重复/);
});
