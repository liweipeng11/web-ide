export { checkCodeImports, checkExistence, extractImportReferences } from "./existenceChecker.js";
export { resolvePathAlias } from "./aliasResolver.js";
export { resolvePackageImport } from "./packageResolver.js";
export type {
  ExistenceCandidate,
  ExistenceCheckKind,
  ExistenceCheckResult,
  ExistenceCheckTarget,
  ExistenceCheckerResult,
  ExistenceStatus,
  ImportReference,
  ReferenceResolution,
  ReferenceResolutionStatus
} from "./types.js";
