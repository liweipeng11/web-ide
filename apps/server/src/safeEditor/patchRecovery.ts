import type { ImpactAnalysisOptions, ImpactAnalysisResult, ImpactChangeTarget } from "../impactAnalyzer/index.js";
import { decideImpactPreflight, executeImpactPreflight } from "./impactPreflight.js";
import { buildSafeEditRecommendation, evaluateSafeEditRollout } from "./safeEditor.js";
import type { SafeEditCandidate, SafeEditRecommendation, SafeEditReport, SafeEditTelemetry, StructuredModificationPlan } from "./types.js";

export type EditPatchImpactAnalysisExecutor = (
  workspaceRoot: string,
  targets: ImpactChangeTarget[],
  options?: ImpactAnalysisOptions
) => Promise<ImpactAnalysisResult>;

export type EditPatchSafeEditOptions = {
  previousAnalyses?: ImpactAnalysisResult[];
  executeImpactAnalysis?: EditPatchImpactAnalysisExecutor;
  evidenceV2Enabled?: boolean;
};

export type PatchSafeEditPreflightResult = {
  recommendation: SafeEditRecommendation;
  analysisAttemptCount: number;
  analysisIncomplete: boolean;
};

type PreparePatchSafeEditInput = {
  workspaceRoot: string;
  selectedFilePath: string | null;
  modificationPlan?: StructuredModificationPlan;
  recommendationOverride?: SafeEditRecommendation;
  previousAnalyses?: ImpactAnalysisResult[];
  executeImpactAnalysis?: EditPatchImpactAnalysisExecutor;
  evidenceV2Enabled?: boolean;
};

type RecoverPatchSafeEditInput = PreparePatchSafeEditInput & {
  taskDescription: string;
  candidates: SafeEditCandidate[];
  current: PatchSafeEditPreflightResult;
};

type SafeEditRolloutComparison = {
  legacyStatus: SafeEditReport["status"];
  nextStatus: SafeEditReport["status"];
  legacyExpansionCount: number;
  nextExpansionCount: number;
};

function formatImpactAnalysisError(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? `自动影响分析失败：${error.message.trim()}`
    : "自动影响分析失败：未知错误";
}

function buildIncompleteRecommendation(plan: StructuredModificationPlan, diagnostic: string) {
  return buildSafeEditRecommendation({
    modificationPlan: plan,
    evidence: {
      sources: ["agent_plan", ...(plan.files.some((file) => file.changeKind === "create") ? ["planned_file_graph" as const] : [])],
      complete: false,
      diagnostics: [diagnostic]
    }
  });
}

/** 在候选补丁生成前建立权威范围证据，并把自动分析次数限制在一次。 */
export async function preparePatchSafeEditRecommendation(input: PreparePatchSafeEditInput): Promise<PatchSafeEditPreflightResult> {
  if (!input.modificationPlan) {
    return {
      recommendation: input.recommendationOverride || buildSafeEditRecommendation({ fallbackTargetFiles: input.selectedFilePath ? [input.selectedFilePath] : [] }),
      analysisAttemptCount: 0,
      analysisIncomplete: false
    };
  }

  const decision = decideImpactPreflight(input.modificationPlan, input.previousAnalyses);
  if (decision.strategy === "analyze" && !input.executeImpactAnalysis) {
    return {
      recommendation: buildIncompleteRecommendation(input.modificationPlan, "当前补丁链路缺少影响分析执行器，无法完成必需的自动预检。"),
      analysisAttemptCount: 0,
      analysisIncomplete: true
    };
  }

  try {
    const preflight = await executeImpactPreflight({
      workspaceRoot: input.workspaceRoot,
      plan: input.modificationPlan,
      previousAnalyses: input.previousAnalyses,
      executeAnalysis: input.executeImpactAnalysis || (async () => {
        throw new Error("Impact analysis executor is unavailable");
      })
    });
    return {
      recommendation: buildSafeEditRecommendation({
        ...(preflight.analysis ? { impactAnalysis: preflight.analysis } : {}),
        modificationPlan: input.modificationPlan,
        fallbackTargetFiles: input.selectedFilePath ? [input.selectedFilePath] : [],
        evidence: preflight.evidence
      }),
      analysisAttemptCount: preflight.decision.strategy === "analyze" ? 1 : 0,
      analysisIncomplete: Boolean(preflight.analysis && !preflight.analysis.complete)
    };
  } catch (error) {
    return {
      recommendation: buildIncompleteRecommendation(input.modificationPlan, formatImpactAnalysisError(error)),
      analysisAttemptCount: decision.strategy === "analyze" ? 1 : 0,
      analysisIncomplete: true
    };
  }
}

/** needs_analysis 只允许补跑一次；真实扩散和不完整分析都不会进入循环恢复。 */
export async function recoverPatchSafeEditReport(input: RecoverPatchSafeEditInput): Promise<{ report: SafeEditReport; state: PatchSafeEditPreflightResult; telemetry: SafeEditTelemetry; comparison: SafeEditRolloutComparison }> {
  const evaluationInput = {
    taskDescription: input.taskDescription,
    recommendation: input.current.recommendation,
    candidates: input.candidates
  };
  const initialRollout = evaluateSafeEditRollout(evaluationInput, input.evidenceV2Enabled ?? true);
  let report = initialRollout.report;
  const createTelemetry = (finalState: PatchSafeEditPreflightResult, finalReport: SafeEditReport, falseExpansionRegressionCount: number): SafeEditTelemetry => ({
    needsAnalysisCount: initialRollout.report.status === "needs_analysis" ? 1 : 0,
    autoAnalysisAttemptCount: finalState.analysisAttemptCount,
    autoAnalysisSuccessCount: finalState.analysisAttemptCount > 0 && !finalState.analysisIncomplete && finalReport.status !== "needs_analysis" ? 1 : 0,
    confirmedExpansionCount: finalReport.files.filter((file) => file.role === "expansion" && file.risks.some((risk) => risk.kind === "scope_expansion")).length,
    riskAcknowledgementCount: 0,
    falseExpansionRegressionCount
  });
  const createComparison = (rollout: typeof initialRollout): SafeEditRolloutComparison => ({
    legacyStatus: rollout.legacyReport.status,
    nextStatus: rollout.nextReport.status,
    legacyExpansionCount: rollout.legacyReport.expansionFiles.length,
    nextExpansionCount: rollout.nextReport.expansionFiles.length
  });
  if (
    report.status !== "needs_analysis"
    || input.current.analysisAttemptCount >= 1
    || input.current.analysisIncomplete
    || !input.modificationPlan
    || !input.executeImpactAnalysis
  ) {
    return {
      report,
      state: input.current,
      telemetry: createTelemetry(input.current, report, initialRollout.falseExpansionRegressionCount),
      comparison: createComparison(initialRollout)
    };
  }

  const recovered = await preparePatchSafeEditRecommendation({
    workspaceRoot: input.workspaceRoot,
    selectedFilePath: input.selectedFilePath,
    modificationPlan: input.modificationPlan,
    previousAnalyses: [],
    executeImpactAnalysis: input.executeImpactAnalysis
  });
  const state = {
    ...recovered,
    // 即使执行器异常或策略发生变化，本次恢复也已经消费唯一重试额度。
    analysisAttemptCount: 1
  };
  const finalRollout = evaluateSafeEditRollout({
    taskDescription: input.taskDescription,
    recommendation: state.recommendation,
    candidates: input.candidates
  }, input.evidenceV2Enabled ?? true);
  report = finalRollout.report;
  return {
    report,
    state,
    telemetry: createTelemetry(state, report, finalRollout.falseExpansionRegressionCount),
    comparison: createComparison(finalRollout)
  };
}
