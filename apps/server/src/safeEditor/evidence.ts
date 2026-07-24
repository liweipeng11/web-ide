import type { SafeEditEvidence, SafeEditEvidenceSource, SafeEditRecommendation } from "./types.js";

function uniqueValues<T extends string>(values: T[]) {
  return [...new Set(values)];
}

/**
 * 将历史 recommendation 的单一 evidenceSource 转换为组合证据。
 * 旧报告没有 evidence 字段时仍可安全读取，不要求数据迁移。
 */
export function resolveSafeEditEvidence(recommendation: Pick<SafeEditRecommendation, "evidenceSource" | "impactAnalysisComplete" | "diagnostics"> & Partial<Pick<SafeEditRecommendation, "evidence">>): SafeEditEvidence {
  if (recommendation.evidence) {
    return {
      sources: uniqueValues(recommendation.evidence.sources || []),
      complete: recommendation.evidence.complete,
      diagnostics: uniqueValues(recommendation.evidence.diagnostics || [])
    };
  }

  const sources: SafeEditEvidenceSource[] = recommendation.evidenceSource === "none" ? [] : [recommendation.evidenceSource];
  return {
    sources,
    complete: recommendation.evidenceSource !== "none" && recommendation.impactAnalysisComplete !== false,
    diagnostics: uniqueValues(recommendation.diagnostics || [])
  };
}
