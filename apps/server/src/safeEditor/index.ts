export { buildSafeEditRecommendation, evaluateLegacySafeEdit, evaluateSafeEdit, evaluateSafeEditRollout } from "./safeEditor.js";
export { resolveSafeEditEvidence } from "./evidence.js";
export {
  decideImpactPreflight,
  executeImpactPreflight,
  IMPACT_ANALYSIS_FRESHNESS_MS
} from "./impactPreflight.js";
export type {
  ExecuteImpactPreflightInput,
  ImpactPreflightDecision,
  ImpactPreflightReason,
  ImpactPreflightResult
} from "./impactPreflight.js";
export { preparePatchSafeEditRecommendation, recoverPatchSafeEditReport } from "./patchRecovery.js";
export type {
  EditPatchImpactAnalysisExecutor,
  EditPatchSafeEditOptions,
  PatchSafeEditPreflightResult
} from "./patchRecovery.js";
export type { SafeEditTelemetry } from "./types.js";
export {
  createStructuredModificationPlan,
  normalizeStructuredModificationPlan,
  validatePatchSubsetOfPlan,
  validateStructuredModificationPlan
} from "./plannedChanges.js";
export type * from "./types.js";
