import { findCheckpointsByActionId } from "../../checkpointStore.js";
import { readWorkspaceFile, readWorkspaceFileBuffer, workspacePathExists } from "../../fileTools.js";
import { normalizePatchPath } from "../../patchStore.js";
import { runtimeError } from "../../runtime/errors.js";
import type { Checkpoint } from "../../types.js";
import type { PatchApplicationReceipt, PatchApprovalStateValue } from "./patchApprovalState.js";

export interface PatchApplicationRecoveryDependencies {
  findCheckpoints: (actionId: string) => Promise<Checkpoint[]>;
  pathExists: (filePath: string) => Promise<boolean>;
  readText: (filePath: string) => Promise<string>;
  readBuffer: (filePath: string) => Promise<Buffer>;
}

export type PatchApplicationRecoveryResult =
  | { status: "not_applied"; checkpointIds: string[] }
  | { status: "applied"; receipt: PatchApplicationReceipt };

const defaultDependencies: PatchApplicationRecoveryDependencies = {
  findCheckpoints: findCheckpointsByActionId,
  pathExists: workspacePathExists,
  readText: readWorkspaceFile,
  readBuffer: readWorkspaceFileBuffer
};

function normalizedPaths(paths: string[]) {
  return [...new Set(paths.map(normalizePatchPath))].sort();
}

function samePaths(left: string[], right: string[]) {
  return JSON.stringify(normalizedPaths(left)) === JSON.stringify(normalizedPaths(right));
}

async function fileMatches(
  file: Checkpoint["files"][number],
  phase: "before" | "after",
  dependencies: PatchApplicationRecoveryDependencies
) {
  const expectedExists = phase === "before" ? file.beforeExists !== false : file.afterExists !== false;
  const exists = await dependencies.pathExists(file.filePath);
  if (exists !== expectedExists) return false;
  if (!exists) return true;

  if (file.isBinary) {
    const expected = phase === "before" ? file.beforeContentBase64 : file.afterContentBase64;
    return typeof expected === "string" && (await dependencies.readBuffer(file.filePath)).toString("base64") === expected;
  }
  const expected = phase === "before" ? file.beforeContent : file.afterContent;
  return await dependencies.readText(file.filePath) === expected;
}

async function inspectCheckpoint(
  checkpoint: Checkpoint,
  dependencies: PatchApplicationRecoveryDependencies
): Promise<"before" | "after" | "ambiguous"> {
  const before = await Promise.all(checkpoint.files.map((file) => fileMatches(file, "before", dependencies)));
  const after = await Promise.all(checkpoint.files.map((file) => fileMatches(file, "after", dependencies)));
  if (after.every(Boolean)) return "after";
  if (before.every(Boolean)) return "before";
  return "ambiguous";
}

/**
 * 通过文件 Checkpoint 与当前磁盘内容恢复副作用结果。Checkpoint 在写入前创建，
 * 因此必须逐文件核对 after 快照，不能仅凭快照文件存在就宣称应用成功。
 */
export async function recoverPatchApplication(
  state: PatchApprovalStateValue,
  dependencies: PatchApplicationRecoveryDependencies = defaultDependencies
): Promise<PatchApplicationRecoveryResult> {
  const checkpoints = await dependencies.findCheckpoints(state.applyActionId);
  if (!checkpoints.length) return { status: "not_applied", checkpointIds: [] };

  const matching = checkpoints.filter((checkpoint) => {
    const source = checkpoint.source;
    return checkpoint.taskId === state.patchId
      && source?.patchId === state.patchId
      && source.taskSessionId === state.taskSessionId
      && source.actionId === state.applyActionId;
  });
  if (matching.length !== checkpoints.length) {
    throw runtimeError("INVALID_CONTRACT", "稳定 Apply Action ID 关联到了其他任务或 Patch 的 Checkpoint。", {
      actionId: state.applyActionId,
      checkpointIds: checkpoints.map((checkpoint) => checkpoint.id)
    });
  }
  for (const checkpoint of matching) {
    if (!samePaths(checkpoint.files.map((file) => file.filePath), state.filePaths)) {
      throw runtimeError("INVALID_CONTRACT", "恢复 Checkpoint 的文件集合与已审批 Patch 不一致。", {
        checkpointId: checkpoint.id
      });
    }
  }

  const inspections = await Promise.all(matching.map(async (checkpoint) => ({
    checkpoint,
    diskState: await inspectCheckpoint(checkpoint, dependencies)
  })));
  const ambiguous = inspections.filter((item) => item.diskState === "ambiguous");
  if (ambiguous.length) {
    throw runtimeError("INVALID_STATE_TRANSITION", "Patch 写入处于部分完成或内容已漂移状态，需要人工检查后恢复。", {
      actionId: state.applyActionId,
      checkpointIds: ambiguous.map((item) => item.checkpoint.id)
    });
  }

  const applied = inspections.filter((item) => item.diskState === "after").at(-1);
  if (!applied) {
    return { status: "not_applied", checkpointIds: matching.map((checkpoint) => checkpoint.id) };
  }
  return {
    status: "applied",
    receipt: {
      actionId: state.applyActionId,
      taskSessionId: state.taskSessionId,
      patchId: state.patchId,
      checkpointId: applied.checkpoint.id,
      filePaths: applied.checkpoint.files.map((file) => file.filePath),
      appliedAt: applied.checkpoint.createdAt,
      recoveredFromCheckpoint: true
    }
  };
}
