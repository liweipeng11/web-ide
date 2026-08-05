import { runEvaluationSuite, type EvaluationReport } from "../evaluation/index.js";
import { createServerCapabilities, implementedFeatures, readFeatureFlags, type FeatureFlags } from "../featureFlags.js";

export const stage5MinimumCompletionRate = 90;

export type Stage5AcceptanceCheck = {
  id: string;
  category: "default_activation" | "rollback" | "integration_scenario";
  title: string;
  passed: boolean;
  detail: string;
};

export type Stage5AcceptanceReport = {
  schemaVersion: 1;
  stage: 5;
  generatedAt: string;
  threshold: number;
  accepted: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    completionRate: number;
  };
  checks: Stage5AcceptanceCheck[];
  evaluation: EvaluationReport["summary"];
};

// 阶段 5 的历史验收仅覆盖当时已发布能力；阶段 0 的默认关闭开关由专用夹具验收。
const featureLabels: Record<Exclude<keyof FeatureFlags, "progressiveDelivery">, string> = {
  contextBudgetV2: "Context Budget V2",
  modelProviderGateway: "Model Provider Gateway",
  lsp: "Language Service / LSP",
  inlineEdit: "Inline Edit",
  commandExecutionV2: "Command Execution V2",
  plannedFileResolution: "Agent Planned File Resolution",
  semanticCompletionCheck: "Agent Semantic Completion Check",
  safeEditEvidenceV2: "Safe Edit Evidence V2",
  explicitCompletionTool: "Agent Explicit Completion Tool",
  taskRuntimeEvidencePersistence: "Task Runtime Evidence Persistence",
  completionRejectionConvergence: "Completion Rejection Convergence",
  structuredCompletionRejection: "Structured Completion Rejection"
};

const disabledEnvironment: NodeJS.ProcessEnv = {
  CONTEXT_BUDGET_V2_ENABLED: "0",
  MODEL_PROVIDER_GATEWAY_ENABLED: "0",
  LSP_ENABLED: "0",
  INLINE_EDIT_ENABLED: "0",
  COMMAND_EXECUTION_V2_ENABLED: "0",
  AGENT_PLANNED_FILE_RESOLUTION: "0",
  AGENT_SEMANTIC_COMPLETION_CHECK: "0",
  SAFE_EDIT_EVIDENCE_V2_ENABLED: "0",
  AGENT_EXPLICIT_COMPLETION_TOOL: "0",
  AGENT_TASK_RUNTIME_EVIDENCE_PERSISTENCE: "0",
  AGENT_COMPLETION_REJECTION_CONVERGENCE: "0",
  AGENT_STRUCTURED_COMPLETION_REJECTION: "0"
};

/**
 * 汇总阶段 0-4 的关键交付物，形成可机器判定的阶段 5 发布验收报告。
 */
export async function runStage5Acceptance(options: { evaluation?: EvaluationReport } = {}): Promise<Stage5AcceptanceReport> {
  const evaluation = options.evaluation ?? await runEvaluationSuite();
  const defaultFlags = readFeatureFlags({});
  const defaultCapabilities = createServerCapabilities({
    flags: defaultFlags,
    implementations: implementedFeatures,
    aiConfigured: true,
    defaultModel: "acceptance-model"
  });
  const disabledFlags = readFeatureFlags(disabledEnvironment);
  const disabledCapabilities = createServerCapabilities({
    flags: disabledFlags,
    implementations: implementedFeatures,
    aiConfigured: true,
    defaultModel: "acceptance-model"
  });

  const featureNames = Object.keys(featureLabels) as Array<keyof typeof featureLabels>;
  const checks: Stage5AcceptanceCheck[] = featureNames.flatMap((name) => [
    {
      id: `default-${name}`,
      category: "default_activation" as const,
      title: `${featureLabels[name]} 默认启用`,
      passed: defaultCapabilities.features[name].active,
      detail: `enabled=${defaultCapabilities.features[name].enabled}, available=${defaultCapabilities.features[name].available}, path=${defaultCapabilities.features[name].path}`
    },
    {
      id: `rollback-${name}`,
      category: "rollback" as const,
      title: `${featureLabels[name]} 可显式回退`,
      passed: !disabledCapabilities.features[name].active && disabledCapabilities.features[name].path === "legacy",
      detail: `enabled=${disabledCapabilities.features[name].enabled}, path=${disabledCapabilities.features[name].path}`
    }
  ]);

  for (const item of evaluation.cases) {
    checks.push({
      id: `scenario-${item.scenarioId}`,
      category: "integration_scenario",
      title: item.title,
      passed: item.passed,
      detail: item.passed ? "离线集成场景通过" : item.failures.join("；")
    });
  }

  const passed = checks.filter((item) => item.passed).length;
  const completionRate = checks.length === 0 ? 0 : Number(((passed / checks.length) * 100).toFixed(2));
  return {
    schemaVersion: 1,
    stage: 5,
    generatedAt: new Date().toISOString(),
    threshold: stage5MinimumCompletionRate,
    accepted: completionRate >= stage5MinimumCompletionRate,
    summary: { total: checks.length, passed, failed: checks.length - passed, completionRate },
    checks,
    evaluation: evaluation.summary
  };
}
