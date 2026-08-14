import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { runtimeError } from "../../runtime/errors.js";
import { graphThreadIdForTask } from "../persistence/threadIdentity.js";
import { recoverPatchApplication, type PatchApplicationRecoveryDependencies } from "./patchApplicationRecovery.js";
import { createPatchApplyNode, type PatchApplyNodeDependencies } from "./patchApplyNode.js";
import {
  PatchApprovalState,
  type PatchApplicationReceipt,
  type PatchApprovalStateValue
} from "./patchApprovalState.js";

export type PatchApplicationGraphOptions = {
  checkpointer: BaseCheckpointSaver;
  writeScope: string[];
  acknowledgeSafeEditRisk?: boolean;
  applyDependencies?: PatchApplyNodeDependencies;
  recoveryDependencies?: PatchApplicationRecoveryDependencies;
};

/** 每个 Patch action 使用独立 thread，避免同一任务的多次写入互相覆盖状态。 */
export function patchApplicationGraphConfig(state: Pick<PatchApprovalStateValue, "taskSessionId" | "applyActionId">) {
  return {
    configurable: {
      thread_id: graphThreadIdForTask(state.taskSessionId, `patch-application-${state.applyActionId}`),
      checkpoint_ns: ""
    }
  };
}

/**
 * 已审批 Patch 的持久化副作用图。恢复检查独立于真实写入节点：进程若在写入后、
 * Graph 状态保存前退出，新实例会先核对文件 Checkpoint，确认完成后不会重复写入。
 */
export function createPatchApplicationGraph(options: PatchApplicationGraphOptions) {
  const applyNode = createPatchApplyNode({
    writeScope: options.writeScope,
    acknowledgeSafeEditRisk: options.acknowledgeSafeEditRisk,
    dependencies: options.applyDependencies
  });

  return new StateGraph(PatchApprovalState)
    .addNode("recover_application", async (state) => {
      if (state.application) return {};
      const recovered = await recoverPatchApplication(state, options.recoveryDependencies);
      return recovered.status === "applied" ? { application: recovered.receipt } : {};
    })
    .addNode("apply_approved_patch", applyNode)
    .addEdge(START, "recover_application")
    .addConditionalEdges("recover_application", (state) => state.application ? "completed" : "apply", {
      completed: END,
      apply: "apply_approved_patch"
    })
    .addEdge("apply_approved_patch", END)
    .compile({ checkpointer: options.checkpointer });
}

export type PatchApplicationGraph = ReturnType<typeof createPatchApplicationGraph>;

function normalizedPaths(paths: string[]) {
  return [...new Set(paths.map((value) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()))].sort();
}

function assertPersistedReceipt(state: PatchApprovalStateValue, receipt: PatchApplicationReceipt) {
  if (state.status !== "approved" || state.resolutionSource !== "user") {
    throw runtimeError("INVALID_STATE_TRANSITION", "只有用户明确批准的 Patch 才能读取应用图终态。", {
      approvalStatus: state.status,
      resolutionSource: state.resolutionSource
    });
  }
  const sameIdentity = receipt.actionId === state.applyActionId
    && receipt.taskSessionId === state.taskSessionId
    && receipt.patchId === state.patchId;
  const sameFiles = JSON.stringify(normalizedPaths(receipt.filePaths)) === JSON.stringify(normalizedPaths(state.filePaths));
  if (!sameIdentity || !sameFiles) {
    throw runtimeError("INVALID_CONTRACT", "持久化 Patch 应用回执与当前审批状态不一致。", {
      actionId: state.applyActionId,
      patchId: state.patchId
    });
  }
}

/**
 * 首次运行写入完整审批状态；恢复时从 saver 继续。终态重放直接返回已持久化回执。
 */
export async function runPatchApplicationGraph(
  graph: PatchApplicationGraph,
  state: PatchApprovalStateValue
): Promise<PatchApplicationReceipt> {
  const config = patchApplicationGraphConfig(state);
  const snapshot = await graph.getState(config);
  const persisted = snapshot.values as Partial<PatchApprovalStateValue>;
  if (persisted.application) {
    // checkpoint 命中也不能跳过业务身份核验，避免调用方伪造旧终态。
    assertPersistedReceipt(state, persisted.application);
    return persisted.application;
  }

  const result = await graph.invoke(
    Object.keys(persisted).length ? null : state,
    config
  ) as PatchApprovalStateValue;
  if (!result.application) {
    throw runtimeError("INVALID_STATE_TRANSITION", "Patch 应用图结束时缺少应用回执。", {
      patchId: state.patchId,
      actionId: state.applyActionId
    });
  }
  assertPersistedReceipt(state, result.application);
  return result.application;
}
