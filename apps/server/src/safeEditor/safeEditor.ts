import type { ImpactChangeKind } from "../impactAnalyzer/index.js";
import { classifySafeEditCandidate } from "./changeClassifier.js";
import type { BuildSafeEditRecommendationInput, EvaluateSafeEditInput, SafeEditEvidenceSource, SafeEditFileAssessment, SafeEditRecommendation, SafeEditReport, SafeEditRisk } from "./types.js";

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniquePaths(paths: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return paths.flatMap((value) => {
    const normalized = value ? normalizePath(value) : "";
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function requiresConsumerUpdate(changeKind: ImpactChangeKind | undefined) {
  return changeKind === "delete" || changeKind === "rename" || changeKind === "signature";
}

/** 从影响分析中提取最小修改建议；只有破坏性变更才把直接消费者列为条件修改。 */
export function buildSafeEditRecommendation(input: BuildSafeEditRecommendationInput): SafeEditRecommendation {
  const analysis = input.impactAnalysis;
  const resolvedChanges = analysis?.changes.filter((change) => change.status === "resolved") || [];
  const plannedFiles = input.modificationPlan?.files.map((file) => file.filePath) || [];
  // fallback 只在缺少可靠分析目标时使用，避免把界面当前选中文件误判为业务变更目标。
  const requiredFiles = uniquePaths([
    ...(analysis ? resolvedChanges.map((change) => change.filePath) : []),
    ...plannedFiles,
    ...(!analysis && !plannedFiles.length ? input.fallbackTargetFiles || [] : [])
  ]);
  const disruptiveTargets = new Set(resolvedChanges.filter((change) => requiresConsumerUpdate(change.changeKind)).map((change) => change.filePath.toLowerCase()));
  const conditionalFiles = uniquePaths((analysis?.impactedFiles || [])
    .filter((file) => file.depth === 1 && file.reasons.some((reason) => disruptiveTargets.has(reason.targetFile.toLowerCase())))
    .filter((file) => !file.categories.includes("test"))
    .map((file) => file.filePath))
    .filter((filePath) => !requiredFiles.some((required) => required.toLowerCase() === filePath.toLowerCase()));
  const conditionalSet = new Set(conditionalFiles.map((filePath) => filePath.toLowerCase()));
  const requiredSet = new Set(requiredFiles.map((filePath) => filePath.toLowerCase()));
  const validationFiles = uniquePaths([...(analysis?.impactedFiles.map((file) => file.filePath) || []), ...(analysis?.relatedTests || [])])
    .filter((filePath) => !requiredSet.has(filePath.toLowerCase()) && !conditionalSet.has(filePath.toLowerCase()));
  const legacyEvidenceSource = analysis ? "impact_analysis" : input.modificationPlan ? "explicit_target" : requiredFiles.length ? "explicit_target" : "none";
  const derivedSources: SafeEditEvidenceSource[] = [
    ...(analysis ? ["impact_analysis" as const] : []),
    ...(input.modificationPlan ? ["agent_plan" as const] : []),
    ...(!analysis && !input.modificationPlan && requiredFiles.length ? ["explicit_target" as const] : [])
  ];
  const evidenceSources = [...new Set([...(input.evidence?.sources || []), ...derivedSources])];
  // 预检显式给出的完整性优先级最高，避免“存在修改计划”掩盖影响分析失败。
  const evidenceComplete = input.evidence
    ? input.evidence.complete && (analysis?.complete ?? true)
    : analysis
      ? analysis.complete
      : input.modificationPlan
        ? true
        : requiredFiles.length > 0;
  const diagnostics = [...new Set([...(analysis?.diagnostics || []), ...(input.evidence?.diagnostics || [])])];

  return {
    requiredFiles,
    conditionalFiles,
    validationFiles,
    editableScopeFiles: uniquePaths(input.editableScopeFiles || []),
    impactAnalysisComplete: analysis ? analysis.complete : null,
    evidenceSource: legacyEvidenceSource,
    evidence: {
      sources: evidenceSources,
      complete: evidenceComplete,
      diagnostics
    },
    diagnostics
  };
}

/** 评估最终候选 diff，并把必要改动与扩散改动分开呈现。 */
function createReport(recommendation: SafeEditRecommendation, files: SafeEditFileAssessment[]): SafeEditReport {
  const risks = files.flatMap((file) => file.risks);
  const hasEvidenceGap = risks.some((risk) => risk.kind === "missing_impact_analysis" || risk.kind === "incomplete_impact_analysis");
  const hasConfirmedHighRisk = risks.some(
    (risk) => risk.level === "high" && risk.kind !== "missing_impact_analysis" && risk.kind !== "incomplete_impact_analysis"
  );
  return {
    status: hasConfirmedHighRisk ? "high_risk" : hasEvidenceGap ? "needs_analysis" : risks.length ? "warning" : "clean",
    recommendation,
    files,
    necessaryFiles: files.filter((file) => file.role === "required" || file.role === "supporting").map((file) => file.filePath),
    expansionFiles: files.filter((file) => file.role === "validation_only" || file.role === "expansion").map((file) => file.filePath),
    risks
  };
}

/** 评估最终候选 diff，并把必要改动与扩散改动分开呈现。 */
export function evaluateSafeEdit(input: EvaluateSafeEditInput): SafeEditReport {
  return createReport(
    input.recommendation,
    input.candidates.map((candidate) => classifySafeEditCandidate(candidate, input.recommendation, input.taskDescription))
  );
}

/**
 * 保留阶段 0 的旧判定作为一个发布周期内的紧急回滚路径。
 * 旧逻辑会把“缺少证据”误当成已确认扩散，只用于灰度比较和显式回退。
 */
export function evaluateLegacySafeEdit(input: EvaluateSafeEditInput): SafeEditReport {
  const next = evaluateSafeEdit(input);
  if (input.recommendation.evidence.sources.length || input.recommendation.evidenceSource !== "none") return next;

  const files = next.files.map((file): SafeEditFileAssessment => {
    if (file.role !== "unverified") return file;
    const retainedRisks = file.risks.filter((risk) => risk.kind !== "missing_impact_analysis" && risk.kind !== "incomplete_impact_analysis");
    const expansionRisk: SafeEditRisk = {
      kind: "scope_expansion",
      level: "high",
      filePath: file.filePath,
      message: "旧版判定在缺少范围证据时将该文件视为范围扩散。"
    };
    return { ...file, role: "expansion", risks: [...retainedRisks, expansionRisk] };
  });
  return createReport(input.recommendation, files);
}

/** 同时计算新旧结果，实际采用路径由 Feature Flag 决定。 */
export function evaluateSafeEditRollout(input: EvaluateSafeEditInput, evidenceV2Enabled: boolean) {
  const nextReport = evaluateSafeEdit(input);
  const legacyReport = evaluateLegacySafeEdit(input);
  const nextExpansions = new Set(nextReport.expansionFiles.map((filePath) => filePath.toLowerCase()));
  return {
    report: evidenceV2Enabled ? nextReport : legacyReport,
    nextReport,
    legacyReport,
    falseExpansionRegressionCount: legacyReport.expansionFiles.filter((filePath) => !nextExpansions.has(filePath.toLowerCase())).length
  };
}
