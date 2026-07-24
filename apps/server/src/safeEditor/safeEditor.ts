import type { ImpactChangeKind } from "../impactAnalyzer/index.js";
import { classifySafeEditCandidate } from "./changeClassifier.js";
import type { BuildSafeEditRecommendationInput, EvaluateSafeEditInput, SafeEditEvidenceSource, SafeEditRecommendation, SafeEditReport } from "./types.js";

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
  // fallback 只在缺少可靠分析目标时使用，避免把界面当前选中文件误判为业务变更目标。
  const requiredFiles = uniquePaths(analysis ? resolvedChanges.map((change) => change.filePath) : input.fallbackTargetFiles || []);
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
  const legacyEvidenceSource = analysis ? "impact_analysis" : requiredFiles.length ? "explicit_target" : "none";
  const derivedSources: SafeEditEvidenceSource[] = legacyEvidenceSource === "none" ? [] : [legacyEvidenceSource];
  const evidenceSources = [...new Set([...(input.evidence?.sources || []), ...derivedSources])];
  const evidenceComplete = analysis
    ? analysis.complete && (input.evidence?.complete ?? true)
    : input.evidence
      ? input.evidence.complete
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
export function evaluateSafeEdit(input: EvaluateSafeEditInput): SafeEditReport {
  const files = input.candidates.map((candidate) => classifySafeEditCandidate(candidate, input.recommendation, input.taskDescription));
  const risks = files.flatMap((file) => file.risks);
  const hasEvidenceGap = risks.some((risk) => risk.kind === "missing_impact_analysis" || risk.kind === "incomplete_impact_analysis");
  const hasConfirmedHighRisk = risks.some(
    (risk) => risk.level === "high" && risk.kind !== "missing_impact_analysis" && risk.kind !== "incomplete_impact_analysis"
  );
  return {
    status: hasConfirmedHighRisk ? "high_risk" : hasEvidenceGap ? "needs_analysis" : risks.length ? "warning" : "clean",
    recommendation: input.recommendation,
    files,
    necessaryFiles: files.filter((file) => file.role === "required" || file.role === "supporting").map((file) => file.filePath),
    expansionFiles: files.filter((file) => file.role === "validation_only" || file.role === "expansion").map((file) => file.filePath),
    risks
  };
}
