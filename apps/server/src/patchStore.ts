import crypto from "node:crypto";
import type { PatchFileChange, PatchGenerationDiagnostics, PendingPatch } from "./types.js";

const patches = new Map<string, PendingPatch>();

export function normalizePatchPath(filePath: string) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function createPendingPatch(files: PatchFileChange[], taskSessionId?: string, commandsToRun?: string[], diagnostics?: PatchGenerationDiagnostics, subagentInfo?: { delegationId?: string; subagentId?: string }) {
  const patch: PendingPatch = {
    patchId: crypto.randomUUID(),
    taskSessionId,
    files,
    commandsToRun,
    diagnostics,
    createdAt: Date.now(),
    delegationId: subagentInfo?.delegationId,
    subagentId: subagentInfo?.subagentId
  };

  patches.set(patch.patchId, patch);
  return patch;
}

export function getPendingPatch(patchId: string) {
  return patches.get(patchId) || null;
}

export function deletePendingPatch(patchId: string) {
  return patches.delete(patchId);
}

export function removePendingPatchFile(patchId: string, filePath: string) {
  const patch = getPendingPatch(patchId);

  if (!patch) {
    return null;
  }

  const normalizedFilePath = normalizePatchPath(filePath);
  patch.files = patch.files.filter((file) => normalizePatchPath(file.path) !== normalizedFilePath);

  if (!patch.files.length) {
    deletePendingPatch(patchId);
    return null;
  }

  patches.set(patch.patchId, patch);
  return patch;
}

export function clearPendingPatches() {
  patches.clear();
}
