export { buildSafeEditRecommendation, evaluateSafeEdit } from "./safeEditor.js";
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
export {
  createStructuredModificationPlan,
  normalizeStructuredModificationPlan,
  validatePatchSubsetOfPlan,
  validateStructuredModificationPlan
} from "./plannedChanges.js";
export type * from "./types.js";
