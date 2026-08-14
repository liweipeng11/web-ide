import { applyPendingPatch } from "../../patchApplyService.js";
import { deletePendingPatch, getPendingPatch, normalizePatchPath } from "../../patchStore.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import { runtimeError } from "../../runtime/errors.js";
import type { PendingPatch } from "../../types.js";
import { recoverPatchApplication } from "./patchApplicationRecovery.js";
import type { PatchApplicationReceipt, PatchApprovalStateValue } from "./patchApprovalState.js";

type PatchApplyResult = Awaited<ReturnType<typeof applyPendingPatch>>;

export interface PatchApplyNodeDependencies {
  getPatch: (patchId: string) => PendingPatch | null;
  applyPatch: typeof applyPendingPatch;
  now: () => number;
  recoverApplication?: typeof recoverPatchApplication;
}

export interface PatchApplyNodeInput {
  state: PatchApprovalStateValue;
  actionId: string;
  writeScope: string[];
  acknowledgeSafeEditRisk?: boolean;
}

const defaultDependencies: PatchApplyNodeDependencies = {
  getPatch: getPendingPatch,
  applyPatch: applyPendingPatch,
  now: Date.now
};

function normalizedPaths(paths: string[]) {
  return [...new Set(paths.map(normalizePatchPath))].sort();
}

function assertSamePaths(actual: string[], expected: string[], message: string) {
  const normalizedActual = normalizedPaths(actual);
  const normalizedExpected = normalizedPaths(expected);
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw runtimeError("INVALID_CONTRACT", message, { actualPaths: normalizedActual, expectedPaths: normalizedExpected });
  }
}

function assertPathsInWriteScope(paths: string[], writeScope: string[], phase: "before" | "after") {
  const blockedPaths = paths.filter((filePath) => !isPathInScope(filePath, writeScope));
  if (blockedPaths.length) {
    throw runtimeError("SCOPE_VIOLATION", `Patch 应用${phase === "before" ? "前" : "后"}检测到 writeScope 外文件。`, {
      phase,
      blockedPaths,
      writeScope
    });
  }
}

function assertApprovedAction(state: PatchApprovalStateValue, actionId: string) {
  if (actionId !== state.applyActionId) {
    throw runtimeError("INVALID_CONTRACT", "Patch 应用 actionId 不匹配。", {
      expectedActionId: state.applyActionId,
      actualActionId: actionId
    });
  }
  if (state.status !== "approved" || state.resolutionSource !== "user") {
    throw runtimeError("INVALID_STATE_TRANSITION", "只有用户明确批准的 Patch 才能进入应用节点。", {
      approvalStatus: state.status,
      resolutionSource: state.resolutionSource
    });
  }
}

function assertApprovedPatch(state: PatchApprovalStateValue, patch: PendingPatch) {
  const source = patch.source;
  if (patch.patchId !== state.patchId
    || patch.taskSessionId !== state.taskSessionId
    || source?.kind !== "langgraph_developer"
    || source.taskId !== state.taskId
    || source.graphRunId !== state.graphRunId
    || source.actionId !== state.proposalActionId) {
    throw runtimeError("INVALID_CONTRACT", "待应用 Patch 的任务或 Graph 来源已经漂移。", {
      patchId: patch.patchId,
      expectedPatchId: state.patchId
    });
  }
  assertSamePaths(patch.files.map((file) => file.path), state.filePaths, "待应用 Patch 的文件集合与已审批内容不一致。");
}

/**
 * 独立执行已审批 Patch 的真实副作用。节点自身不直接访问 fs，所有落盘、Checkpoint
 * 和冲突检测均委托给现有 Patch Apply 服务，避免形成第二套写入语义。
 */
export async function applyApprovedPatchNode(
  input: PatchApplyNodeInput,
  dependencies: PatchApplyNodeDependencies = defaultDependencies
): Promise<PatchApplicationReceipt> {
  assertApprovedAction(input.state, input.actionId);
  if (input.state.application) {
    if (input.state.application.actionId !== input.actionId
      || input.state.application.patchId !== input.state.patchId
      || input.state.application.taskSessionId !== input.state.taskSessionId) {
      throw runtimeError("INVALID_CONTRACT", "Patch 应用回执与当前 action 不匹配。");
    }
    assertSamePaths(input.state.application.filePaths, input.state.filePaths, "Patch 应用回执的文件集合与审批内容不一致。");
    assertPathsInWriteScope(input.state.application.filePaths, input.writeScope, "after");
    return input.state.application;
  }

  const recovery = await (dependencies.recoverApplication ?? recoverPatchApplication)(input.state);
  if (recovery.status === "applied") {
    assertPathsInWriteScope(recovery.receipt.filePaths, input.writeScope, "after");
    // 文件已由相同 action 完成写入时，只清理仍残留的内存 Patch，不再次执行写入。
    deletePendingPatch(input.state.patchId);
    return recovery.receipt;
  }

  const patch = dependencies.getPatch(input.state.patchId);
  if (!patch) {
    throw runtimeError("INVALID_STATE_TRANSITION", "待应用 Patch 不存在，不能推断其已经成功写入。", {
      patchId: input.state.patchId,
      actionId: input.actionId
    });
  }

  assertApprovedPatch(input.state, patch);
  const expectedPaths = patch.files.map((file) => file.path);
  assertPathsInWriteScope(expectedPaths, input.writeScope, "before");

  const result: PatchApplyResult = await dependencies.applyPatch({
    patchId: patch.patchId,
    source: {
      taskSessionId: input.state.taskSessionId,
      actionId: input.state.applyActionId,
      toolName: "langgraph_apply_patch",
      reason: "langgraph_approved_patch"
    },
    // 进入此节点前已经完成高风险 apply_patch 人工审批；needs_analysis 仍由底层服务强制阻断。
    acknowledgeSafeEditRisk: input.acknowledgeSafeEditRisk ?? true
  });

  const appliedPaths = result.files.map((file) => file.path);
  if (result.patchId !== patch.patchId) {
    throw runtimeError("INVALID_CONTRACT", "Patch Apply 返回了错误的 patchId。", {
      expectedPatchId: patch.patchId,
      actualPatchId: result.patchId
    });
  }
  // 即使底层服务未来调整返回内容，副作用节点仍在结果边界再次执行权限校验。
  assertPathsInWriteScope(appliedPaths, input.writeScope, "after");
  assertSamePaths(appliedPaths, expectedPaths, "Patch Apply 返回的文件集合与审批内容不一致。");

  return {
    actionId: input.state.applyActionId,
    taskSessionId: input.state.taskSessionId,
    patchId: result.patchId,
    checkpointId: result.checkpoint.id,
    filePaths: appliedPaths,
    appliedAt: dependencies.now(),
    recoveredFromCheckpoint: false
  };
}

/** 将副作用执行结果作为 Graph state update 返回，便于后续工作包持久化和恢复。 */
export function createPatchApplyNode(options: {
  writeScope: string[];
  acknowledgeSafeEditRisk?: boolean;
  dependencies?: PatchApplyNodeDependencies;
}) {
  return async (state: PatchApprovalStateValue): Promise<Partial<PatchApprovalStateValue>> => ({
    application: await applyApprovedPatchNode({
      state,
      actionId: state.applyActionId,
      writeScope: options.writeScope,
      acknowledgeSafeEditRisk: options.acknowledgeSafeEditRisk
    }, options.dependencies)
  });
}
