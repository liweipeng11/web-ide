import path from "node:path";
import type { EditScope, FilePatch } from "./types.js";
import { validatePatchSubsetOfPlan, type PlannedChange } from "./safeEditor/index.js";

export type BuildEditScopeOptions = {
  selectedFilePath?: string | null;
  filesRead?: string[];
  retryCandidateFiles?: string[];
  allowNewFiles?: boolean;
  plannedChanges?: PlannedChange[];
};

export type EditScopeValidationResult =
  | {
      ok: true;
      files: FilePatch[];
    }
  | {
      ok: false;
      files: FilePatch[];
      blockedFiles: string[];
      allowedExistingFiles: string[];
    };

function normalizeScopePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function uniqueNormalizedPaths(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const value of values) {
    const normalized = typeof value === "string" ? normalizeScopePath(value) : "";

    if (!normalized) continue;

    const key = normalized.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      paths.push(normalized);
    }
  }

  return paths;
}

function getDirectory(filePath: string) {
  const directory = path.posix.dirname(normalizeScopePath(filePath));
  return directory === "." ? "" : directory;
}

function isSameOrChildDirectory(candidateDirectory: string, allowedDirectory: string) {
  if (!allowedDirectory) {
    return candidateDirectory === "" || !candidateDirectory.includes("/");
  }

  return candidateDirectory === allowedDirectory || candidateDirectory.startsWith(`${allowedDirectory}/`);
}

export function buildEditScope(options: BuildEditScopeOptions): EditScope {
  const plannedChanges = options.plannedChanges?.map((change) => ({ ...change }));
  const allowedExistingFiles = uniqueNormalizedPaths([
    ...(plannedChanges?.filter((change) => change.changeKind !== "create").map((change) => change.filePath) || []),
    options.selectedFilePath,
    ...(options.filesRead || []),
    ...(options.retryCandidateFiles || [])
  ]);

  return {
    allowedExistingFiles,
    allowNewFiles: plannedChanges ? plannedChanges.some((change) => change.changeKind === "create") : options.allowNewFiles ?? true,
    createdFileDirectories: uniqueNormalizedPaths([
      ...allowedExistingFiles.map(getDirectory),
      ...(plannedChanges?.filter((change) => change.changeKind === "create").map((change) => getDirectory(change.filePath)) || [])
    ]),
    ...(plannedChanges ? { plannedChanges } : {})
  };
}

export function isExistingFileAllowed(filePath: string, scope: EditScope) {
  const normalized = normalizeScopePath(filePath).toLowerCase();
  return scope.allowedExistingFiles.some((allowedPath) => allowedPath.toLowerCase() === normalized);
}

export function isNewFileAllowed(filePath: string, scope: EditScope) {
  if (!scope.allowNewFiles) {
    return false;
  }

  if (!scope.allowedExistingFiles.length) {
    return true;
  }

  const candidateDirectory = getDirectory(filePath);

  // 新文件只能放在已读/已选文件的同级或子目录，避免模型跳到无关模块新增实现。
  return scope.createdFileDirectories.some((allowedDirectory) => isSameOrChildDirectory(candidateDirectory, allowedDirectory));
}

export function validatePatchesAgainstEditScope(patches: FilePatch[] | null, scope: EditScope): EditScopeValidationResult {
  if (!patches) {
    return { ok: true, files: [] };
  }

  if (scope.plannedChanges) {
    const planValidation = validatePatchSubsetOfPlan(
      patches.map((patch) => ({ filePath: patch.filePath, status: patch.status })),
      scope.plannedChanges
    );
    if (!planValidation.ok) {
      return {
        ok: false,
        files: patches,
        blockedFiles: planValidation.blockedFiles,
        allowedExistingFiles: scope.allowedExistingFiles
      };
    }
    return { ok: true, files: patches };
  }

  const blockedFiles = patches
    .filter((patch) => {
      const isCreate = patch.status ? patch.status === "create" : patch.oldContent === "" && !patch.edits?.length;
      return isCreate ? !isNewFileAllowed(patch.filePath, scope) : !isExistingFileAllowed(patch.filePath, scope);
    })
    .map((patch) => normalizeScopePath(patch.filePath));

  if (!blockedFiles.length) {
    return { ok: true, files: patches };
  }

  return {
    ok: false,
    files: patches,
    blockedFiles,
    allowedExistingFiles: scope.allowedExistingFiles
  };
}
