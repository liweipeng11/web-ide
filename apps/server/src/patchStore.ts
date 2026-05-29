import crypto from "node:crypto";
import type { PatchFileChange, PendingPatch } from "./types.js";

const patches = new Map<string, PendingPatch>();

export function createPendingPatch(files: PatchFileChange[]) {
  const patch: PendingPatch = {
    patchId: crypto.randomUUID(),
    files,
    createdAt: Date.now()
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

export function clearPendingPatches() {
  patches.clear();
}
