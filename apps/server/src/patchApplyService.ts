import { createCheckpoint } from "./checkpointStore.js";
import { HttpError } from "./errors.js";
import { createWorkspaceFile, deleteWorkspaceFile, readWorkspaceFile, readWorkspaceFileBuffer, workspacePathExists, writeWorkspaceFile } from "./fileTools.js";
import { deletePendingPatch, getPendingPatch, normalizePatchPath, removePendingPatchFile } from "./patchStore.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { addTaskSessionCheckpoint, addTaskSessionFilesChanged, advanceTaskPlanProgress, appendTaskSessionPatchEvent, updateTaskSessionStatus } from "./taskSessionStore.js";
import type { AgentStep, CheckpointSource } from "./types.js";

export type ApplyPendingPatchOptions = {
  patchId: string;
  filePath?: string | null;
  source?: CheckpointSource;
  onAgentStep?: (step: AgentStep) => void;
};

/**
 * ????????????????????checkpoint ??????????
 */
export async function applyPendingPatch(options: ApplyPendingPatchOptions) {
  const patch = getPendingPatch(options.patchId);

  if (!patch) {
    throw new HttpError(404, "Patch not found");
  }

  const normalizedFilePath = options.filePath ? normalizePatchPath(options.filePath) : null;
  const targetFiles = normalizedFilePath ? patch.files.filter((file) => normalizePatchPath(file.path) === normalizedFilePath) : patch.files;

  if (!targetFiles.length) {
    throw new HttpError(404, "Patch file not found");
  }

  const deleteFiles = targetFiles.filter((file) => file.status === "delete");

  if (deleteFiles.length) {
    throw new HttpError(422, `Delete patches are disabled. Delete files with runCommand after user approval: ${deleteFiles.map((file) => file.path).join(", ")}`);
  }

  for (const file of targetFiles) {
    if (file.status === "create") {
      if (await workspacePathExists(file.path)) {
        throw new HttpError(409, file.path + " already exists");
      }
      continue;
    }

    if (file.isBinary) {
      const currentContentBase64 = (await readWorkspaceFileBuffer(file.path)).toString("base64");

      if (currentContentBase64 !== file.oldContentBase64) {
        throw new HttpError(409, file.path + " has changed since patch was generated. Regenerate the patch before applying.");
      }

      continue;
    }

    const currentContent = await readWorkspaceFile(file.path);

    // 落盘前确认文件仍是生成补丁时的版本，避免把用户后续改动误删或覆盖。
    if (currentContent !== file.oldContent) {
      throw new HttpError(409, file.path + " has changed since patch was generated. Regenerate the patch before applying.");
    }
  }

  const checkpointSource: CheckpointSource = {
    ...options.source,
    taskSessionId: options.source?.taskSessionId ?? patch.taskSessionId ?? null,
    patchId: patch.patchId,
    reason: options.source?.reason || "apply_patch"
  };
  const checkpoint = await createCheckpoint(patch.patchId, targetFiles, { source: checkpointSource });

  await Promise.all([
    ...targetFiles.filter((file) => file.status === "modify").map((file) => writeWorkspaceFile(file.path, file.newContent)),
    ...targetFiles.filter((file) => file.status === "create").map((file) => createWorkspaceFile(file.path, file.newContent)),
    ...targetFiles.filter((file) => file.status === "delete").map((file) => deleteWorkspaceFile(file.path))
  ]);

  for (const file of targetFiles) {
    if (file.status === "delete") {
      if (await workspacePathExists(file.path)) {
        throw new HttpError(500, file.path + " was not deleted correctly. Apply the patch again after refreshing the workspace.");
      }
      continue;
    }

    const writtenContent = await readWorkspaceFile(file.path);

    if (writtenContent !== file.newContent) {
      throw new HttpError(500, file.path + " was not written correctly. Apply the patch again after refreshing the workspace.");
    }
  }

  await addTaskSessionFilesChanged(patch.taskSessionId, targetFiles.map((file) => file.path));
  await addTaskSessionCheckpoint(patch.taskSessionId, checkpoint.id);
  await Promise.all(
    targetFiles.map((file) =>
      appendTaskSessionPatchEvent(patch.taskSessionId, {
        type: "patch_file_applied",
        patchId: patch.patchId,
        filePath: file.path,
        filePaths: [file.path],
        message: `已应用 ${file.path}`,
        detail: {
          status: file.status,
          checkpointId: checkpoint.id,
          summary: file.summary
        }
      })
    )
  );
  options.onAgentStep?.(
    createAgentStep({
      type: "checkpoint",
      checkpointId: checkpoint.id,
      files: targetFiles.map((file) => file.path),
      source: checkpoint.source
    })
  );
  await advanceTaskPlanProgress(patch.taskSessionId, "patch_applied");

  if (options.filePath) {
    const remainingPatch = removePendingPatchFile(patch.patchId, options.filePath);

    if (!remainingPatch && !patch.commandsToRun?.length) {
      await advanceTaskPlanProgress(patch.taskSessionId, "validation_success");
      await updateTaskSessionStatus(patch.taskSessionId, "success");
    }

    if (!remainingPatch) {
      await appendTaskSessionPatchEvent(patch.taskSessionId, {
        type: "patch_completed",
        patchId: patch.patchId,
        filePaths: targetFiles.map((file) => file.path),
        message: "patch 已处理完成。",
        detail: {
          completedBy: "apply",
          checkpointId: checkpoint.id
        }
      });
    }
  } else {
    deletePendingPatch(patch.patchId);
    await appendTaskSessionPatchEvent(patch.taskSessionId, {
      type: "patch_completed",
      patchId: patch.patchId,
      filePaths: targetFiles.map((file) => file.path),
      message: "patch 已处理完成。",
      detail: {
        completedBy: "apply",
        checkpointId: checkpoint.id
      }
    });

    if (!patch.commandsToRun?.length) {
      await advanceTaskPlanProgress(patch.taskSessionId, "validation_success");
      await updateTaskSessionStatus(patch.taskSessionId, "success");
    }
  }

  return {
    checkpoint,
    files: targetFiles.map((file) => ({ path: file.path, status: file.status, summary: file.summary })),
    patchId: patch.patchId
  };
}
