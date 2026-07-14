import type { ImpactAnalysisResult } from "../impactAnalyzer/index.js";

export type SafeEditFileRole = "required" | "supporting" | "validation_only" | "expansion";
export type SafeEditRiskKind = "scope_expansion" | "missing_impact_analysis" | "incomplete_impact_analysis" | "opportunistic_refactor" | "formatting_only" | "broad_rewrite" | "bulk_rename";

// Safe Editor 只建议修改边界，不把“受影响文件”误当成“必须修改文件”。
export type SafeEditRecommendation = {
  requiredFiles: string[];
  conditionalFiles: string[];
  validationFiles: string[];
  editableScopeFiles: string[];
  impactAnalysisComplete: boolean | null;
  evidenceSource: "impact_analysis" | "explicit_target" | "none";
  diagnostics: string[];
};

export type SafeEditCandidate = {
  filePath: string;
  status: "create" | "modify" | "delete";
  oldContent: string;
  newContent: string;
  summary?: string;
};

export type SafeEditRisk = {
  kind: SafeEditRiskKind;
  level: "low" | "medium" | "high";
  filePath: string;
  message: string;
};

export type SafeEditFileAssessment = {
  filePath: string;
  role: SafeEditFileRole;
  reasons: string[];
  addedLines: number;
  removedLines: number;
  risks: SafeEditRisk[];
};

export type SafeEditReport = {
  status: "clean" | "warning" | "high_risk";
  recommendation: SafeEditRecommendation;
  files: SafeEditFileAssessment[];
  necessaryFiles: string[];
  expansionFiles: string[];
  risks: SafeEditRisk[];
};

export type BuildSafeEditRecommendationInput = {
  impactAnalysis?: ImpactAnalysisResult | null;
  fallbackTargetFiles?: string[];
  editableScopeFiles?: string[];
};

export type EvaluateSafeEditInput = {
  taskDescription: string;
  recommendation: SafeEditRecommendation;
  candidates: SafeEditCandidate[];
};
