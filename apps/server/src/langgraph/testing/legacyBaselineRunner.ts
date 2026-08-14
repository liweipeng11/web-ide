import type { BaselineScenario } from "./baselineScenarios.js";
import type { FakeModel } from "./fakeModel.js";
import { normalizeBaselineResult, type BaselineRunResult, type NormalizedBaselineResult } from "./resultNormalizer.js";

export type LegacyBaselineExecutor = (
  scenario: BaselineScenario,
  context: { model: FakeModel }
) => Promise<BaselineRunResult>;

export type LegacyBaselineCaseResult = {
  scenario: BaselineScenario;
  result: NormalizedBaselineResult;
};

export type LegacyBaselineReport = {
  schemaVersion: 1;
  cases: LegacyBaselineCaseResult[];
};

export type LegacyBaselineRunnerOptions = {
  scenarios: readonly BaselineScenario[];
  model: FakeModel;
  execute: LegacyBaselineExecutor;
};

/**
 * 顺序运行 Legacy 基线场景并生成稳定报告。
 * 具体业务入口由调用方注入，Runner 本身不会访问 Provider、文件系统或生产服务。
 */
export async function runLegacyBaselineSuite(options: LegacyBaselineRunnerOptions): Promise<LegacyBaselineReport> {
  assertUniqueScenarioIds(options.scenarios);
  const cases: LegacyBaselineCaseResult[] = [];

  for (const scenario of options.scenarios) {
    const rawResult = await options.execute(scenario, { model: options.model });
    assertScenarioContract(scenario, rawResult);
    cases.push({ scenario, result: normalizeBaselineResult(rawResult) });
  }

  return { schemaVersion: 1, cases };
}

function assertUniqueScenarioIds(scenarios: readonly BaselineScenario[]): void {
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    if (seen.has(scenario.id)) throw new Error(`基线场景 ID 重复：${scenario.id}`);
    seen.add(scenario.id);
  }
}

function assertScenarioContract(scenario: BaselineScenario, result: BaselineRunResult): void {
  if (result.scenarioId !== scenario.id) {
    throw new Error(`基线结果场景不匹配：期望 ${scenario.id}，实际 ${result.scenarioId}`);
  }
  if (result.outcome !== scenario.expectedOutcome) {
    throw new Error(`基线场景 ${scenario.id} 终态不匹配：期望 ${scenario.expectedOutcome}，实际 ${result.outcome}`);
  }

  // 缺失信号意味着对照无法证明关键行为，必须在生成基线时立即失败。
  const actualSignals = new Set(result.signals);
  const missingSignals = scenario.expectedSignals.filter((signal) => !actualSignals.has(signal));
  if (missingSignals.length > 0) {
    throw new Error(`基线场景 ${scenario.id} 缺少预期信号：${missingSignals.join(", ")}`);
  }
}
