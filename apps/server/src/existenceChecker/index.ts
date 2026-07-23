export { checkCodeImports, checkExistence, checkPatchImports, extractImportReferences } from "./existenceChecker.js";
export { resolvePathAlias } from "./aliasResolver.js";
export { resolvePackageImport } from "./packageResolver.js";
export { buildPlannedFileGraph, getPlannedChangeKind, normalizePlannedFilePath, resolvePlannedFileCandidates } from "./plannedFileResolver.js";
export type {
  ExistenceCandidate,
  ExistenceCheckKind,
  ExistenceCheckResult,
  ExistenceCheckOptions,
  ExistenceCheckTarget,
  ExistenceCheckerResult,
  ExistenceStatus,
  ImportReference,
  PlannedFileChange,
  PlannedFileGraph,
  ReferenceResolution,
  ReferenceResolutionStatus
} from "./types.js";
