import { Annotation } from "@langchain/langgraph";
import type { DeveloperPatchProposalReference } from "../developer/developerGraphState.js";
import { graphActionId, graphApprovalActionId } from "../persistence/threadIdentity.js";
import type { PendingPatch } from "../../types.js";
import { runtimeError } from "../../runtime/errors.js";

export type PatchApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type PatchApprovalResolutionSource = "user" | "timeout";

export interface PatchApplicationReceipt {
  actionId: string;
  taskSessionId: string;
  patchId: string;
  checkpointId: string;
  filePaths: string[];
  appliedAt: number;
  recoveredFromCheckpoint: boolean;
}

export const PatchApprovalState = Annotation.Root({
  taskSessionId: Annotation<string>,
  taskId: Annotation<string>,
  graphRunId: Annotation<string>,
  patchId: Annotation<string>,
  proposalActionId: Annotation<string>,
  approvalActionId: Annotation<string>,
  applyActionId: Annotation<string>,
  filePaths: Annotation<string[]>,
  requestedAt: Annotation<number>,
  expiresAt: Annotation<number>,
  status: Annotation<PatchApprovalStatus>,
  decidedAt: Annotation<number | null>,
  resolutionSource: Annotation<PatchApprovalResolutionSource | null>,
  application: Annotation<PatchApplicationReceipt | null>
});

export type PatchApprovalStateValue = typeof PatchApprovalState.State;

const defaultApprovalTtlMs = 30 * 60 * 1_000;
const maximumApprovalTtlMs = 24 * 60 * 60 * 1_000;

function normalizedPaths(paths: string[]) {
  return [...new Set(paths.map((value) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()))].sort();
}

function assertPatchSource(
  taskSessionId: string,
  patch: PendingPatch,
  proposal: DeveloperPatchProposalReference
) {
  const source = patch.source;
  if (!source || source.kind !== "langgraph_developer") {
    throw runtimeError("INVALID_CONTRACT", "待审批 Patch 缺少 LangGraph Developer 来源。");
  }
  if (patch.taskSessionId !== taskSessionId) {
    throw runtimeError("INVALID_CONTRACT", "待审批 Patch 与 TaskSession 不匹配。", {
      expectedTaskSessionId: taskSessionId,
      actualTaskSessionId: patch.taskSessionId
    });
  }
  if (patch.patchId !== proposal.patchId
    || source.taskId !== proposal.taskId
    || source.graphRunId !== proposal.graphRunId
    || source.actionId !== proposal.actionId) {
    throw runtimeError("INVALID_CONTRACT", "Patch 提议引用与 Pending Patch 来源不一致。", {
      patchId: patch.patchId,
      proposalPatchId: proposal.patchId
    });
  }
  const patchPaths = normalizedPaths(patch.files.map((file) => file.path));
  const proposalPaths = normalizedPaths(proposal.filePaths);
  if (JSON.stringify(patchPaths) !== JSON.stringify(proposalPaths)) {
    throw runtimeError("INVALID_CONTRACT", "Patch 提议文件集合与 Pending Patch 不一致。", {
      patchPaths,
      proposalPaths
    });
  }
}

/**
 * 从已验证的 Patch 提议创建稳定审批身份，同时预先派生后续副作用 action ID。
 * 这里只创建状态，不注册审批、不应用 Patch，也不写 TaskSession。
 */
export function createPatchApprovalState(input: {
  taskSessionId: string;
  patch: PendingPatch;
  proposal: DeveloperPatchProposalReference;
  requestedAt?: number;
  expiresAt?: number;
}): PatchApprovalStateValue {
  const taskSessionId = input.taskSessionId.trim();
  if (!taskSessionId) throw runtimeError("INVALID_CONTRACT", "taskSessionId 不能为空。");
  assertPatchSource(taskSessionId, input.patch, input.proposal);

  const requestedAt = input.requestedAt ?? Date.now();
  const expiresAt = input.expiresAt ?? requestedAt + defaultApprovalTtlMs;
  if (!Number.isFinite(requestedAt) || !Number.isFinite(expiresAt)
    || expiresAt <= requestedAt || expiresAt - requestedAt > maximumApprovalTtlMs) {
    throw runtimeError("INVALID_CONTRACT", "Patch 审批有效期必须大于 0 且不超过 24 小时。", {
      requestedAt,
      expiresAt
    });
  }

  const approvalKey = `apply-patch:${input.patch.patchId}:${input.proposal.actionId}`;
  return {
    taskSessionId,
    taskId: input.proposal.taskId,
    graphRunId: input.proposal.graphRunId,
    patchId: input.patch.patchId,
    proposalActionId: input.proposal.actionId,
    approvalActionId: graphApprovalActionId(taskSessionId, approvalKey),
    applyActionId: graphActionId(input.proposal.taskId, input.proposal.graphRunId, approvalKey),
    filePaths: [...input.proposal.filePaths],
    requestedAt,
    expiresAt,
    status: "pending",
    decidedAt: null,
    resolutionSource: null,
    application: null
  };
}
