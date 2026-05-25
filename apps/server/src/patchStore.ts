import crypto from "node:crypto";
import type { PendingPatch } from "./types.js";

const patches = new Map<string, PendingPatch>();

export function createPendingPatch(filePath: string, oldContent: string, newContent: string) {
  const patch: PendingPatch = {
    patchId: crypto.randomUUID(),
    filePath,
    oldContent,
    newContent,
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
