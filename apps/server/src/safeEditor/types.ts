import type { ImpactAnalysisResult } from "../impactAnalyzer/index.js";

export type SafeEditStatus = "clean" | "warning" | "needs_analysis" | "high_risk";
export type SafeEditFileRole = "required" | "supporting" | "validation_only" | "unverified" | "expansion";
export type SafeEditRiskKind = "scope_expansion" | "missing_impact_analysis" | "incomplete_impact_analysis" | "opportunistic_refactor" | "formatting_only" | "broad_rewrite" | "bulk_rename";
export type SafeEditEvidenceSource = "explicit_target" | "agent_plan" | "impact_analysis" | "planned_file_graph";
export type LegacySafeEditEvidenceSource = "impact_analysis" | "explicit_target" | "none";

export type SafeEditEvidence = {
  sources: SafeEditEvidenceSource[];
  complete: boolean;
  diagnostics: string[];
};

export type PlannedChangeKind = "create" | "modify" | "delete" | "rename" | "signature";

export type PlannedChange = {
  filePath: string;
  changeKind: PlannedChangeKind;
  symbolName?: string;
  reason: string;
};

export type StructuredModificationPlanFile = PlannedChange & {
  /** 可选职责说明用于 Agent 审计，不作为阶段 2 的必填安全字段。 */
  responsibility?: string;
};

export type StructuredModificationPlan = {
  id: string;
  taskDescription: string;
  files: StructuredModificationPlanFile[];
  createdAt: number;
};

export type CreateStructuredModificationPlanInput = Omit<StructuredModificationPlan, "id" | "createdAt"> & {
  id?: string;
  createdAt?: number;
};

// Safe Editor 只建议修改边界，不把“受影响文件”误当成“必须修改文件”。
export type SafeEditRecommendation = {
  requiredFiles: string[];
  conditionalFiles: string[];
  validationFiles: string[];
  editableScopeFiles: string[];
  impactAnalysisComplete: boolean | null;
  /** 保留旧字段以兼容已持久化的报告，新逻辑统一读取 evidence。 */
  evidenceSource: LegacySafeEditEvidenceSource;
  evidence: SafeEditEvidence;
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
  status: SafeEditStatus;
  recommendation: SafeEditRecommendation;
  files: SafeEditFileAssessment[];
  necessaryFiles: string[];
  expansionFiles: string[];
  risks: SafeEditRisk[];
};

export type BuildSafeEditRecommendationInput = {
  impactAnalysis?: ImpactAnalysisResult | null;
  modificationPlan?: StructuredModificationPlan | null;
  fallbackTargetFiles?: string[];
  editableScopeFiles?: string[];
  evidence?: SafeEditEvidence;
};

export type EvaluateSafeEditInput = {
  taskDescription: string;
  recommendation: SafeEditRecommendation;
  candidates: SafeEditCandidate[];
};

export type SafeEditTelemetry = {
  needsAnalysisCount: number;
  autoAnalysisAttemptCount: number;
  autoAnalysisSuccessCount: number;
  confirmedExpansionCount: number;
  riskAcknowledgementCount: number;
  falseExpansionRegressionCount: number;
};
