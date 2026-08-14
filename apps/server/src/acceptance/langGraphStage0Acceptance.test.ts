import assert from "node:assert/strict";
import test from "node:test";
import { defaultFeatureFlags, implementedFeatures, readFeatureFlags } from "../featureFlags.js";
import { baselineScenarios } from "../langgraph/testing/baselineScenarios.js";
import { FakeModel } from "../langgraph/testing/fakeModel.js";
import { runLegacyBaselineSuite, type LegacyBaselineExecutor } from "../langgraph/testing/legacyBaselineRunner.js";

function createDeterministicBaseline() {
  const model = new FakeModel(Object.fromEntries(baselineScenarios.map((scenario) => [
    scenario.id,
    { text: `legacy:${scenario.id}`, signals: scenario.expectedSignals }
  ])));
  const execute: LegacyBaselineExecutor = async (scenario, context) => {
    const response = await context.model.complete({ scenarioId: scenario.id });
    return {
      scenarioId: scenario.id,
      outcome: scenario.expectedOutcome,
      signals: response.signals ?? [],
      message: response.text,
      metadata: { runtime: "legacy", runId: `volatile-${scenario.id}`, durationMs: Date.now() }
    };
  };
  return { model, execute };
}

test("阶段 0 的十四类 Legacy 基线连续运行结果一致", async () => {
  const fixture = createDeterministicBaseline();
  const first = await runLegacyBaselineSuite({ scenarios: baselineScenarios, ...fixture });
  const second = await runLegacyBaselineSuite({ scenarios: baselineScenarios, ...fixture });

  assert.equal(first.cases.length, 14);
  assert.deepEqual(first, second);
  assert.equal(first.cases.every((item) => item.result.metadata?.runtime === "legacy"), true);
});

test("阶段 0 默认不可进入 LangGraph 生产路径，但保留显式验证开关", () => {
  assert.equal(defaultFeatureFlags.langGraphRuntime, false);
  assert.equal(implementedFeatures.langGraphRuntime, false);
  assert.equal(readFeatureFlags({}).langGraphRuntime, false);
  assert.equal(readFeatureFlags({ AGENT_LANGGRAPH_RUNTIME_ENABLED: "true" }).langGraphRuntime, true);
});
