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

export type StablePendingPatchInput = Pick<PendingPatch, "patchId" | "files"> &
  Partial<Pick<PendingPatch, "taskSessionId" | "commandsToRun" | "diagnostics" | "source">>;

function comparablePatch(patch: StablePendingPatchInput) {
  return JSON.stringify({
    taskSessionId: patch.taskSessionId,
    files: patch.files,
    commandsToRun: patch.commandsToRun,
    diagnostics: patch.diagnostics,
    source: patch.source
  });
}

/**
 * Graph 恢复或重复调用时复用稳定 Patch ID；相同 ID 对应不同内容时拒绝覆盖，
 * 防止重放把用户已经看到的待审批 Diff 静默替换。
 */
export function createOrReusePendingPatch(input: StablePendingPatchInput) {
  const patchId = input.patchId.trim();
  if (!patchId) throw new Error("稳定 Patch ID 不能为空。");
  const existing = patches.get(patchId);
  if (existing) {
    if (comparablePatch(existing) !== comparablePatch(input)) {
      throw new Error(`稳定 Patch ID 内容冲突：${patchId}`);
    }
    return existing;
  }

  const patch: PendingPatch = {
    patchId,
    files: input.files,
    createdAt: Date.now(),
    ...(input.taskSessionId ? { taskSessionId: input.taskSessionId } : {}),
    ...(input.commandsToRun ? { commandsToRun: input.commandsToRun } : {}),
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    ...(input.source ? { source: input.source } : {})
  };
  patches.set(patchId, patch);
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
