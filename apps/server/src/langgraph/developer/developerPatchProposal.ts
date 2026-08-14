import crypto from "node:crypto";
import { createDiffHtml, createEditHunks } from "../../diffTools.js";
import { readWorkspaceFileForDiff, workspacePathExists } from "../../fileTools.js";
import { createOrReusePendingPatch } from "../../patchStore.js";
import { runtimeError } from "../../runtime/errors.js";
import { validatePatchSubsetOfPlan } from "../../safeEditor/index.js";
import type { PatchFileChange, PendingPatch } from "../../types.js";
import { graphActionId } from "../persistence/threadIdentity.js";
import type { DeveloperGraphStateValue, DeveloperModificationPlan } from "./developerGraphState.js";
import { evaluateModificationPlan } from "./modificationPlanGate.js";

export interface DeveloperPatchCandidate {
  path: string;
  operation: "create" | "modify" | "delete";
  newContent: string;
  summary: string;
  /** 修改和删除必须绑定生成候选时读取到的基础内容，避免覆盖并发变更。 */
  baseContentHash?: string;
}

export interface DeveloperPatchProposalDependencies {
  inspectFile(path: string): Promise<{ exists: boolean; content: string; isBinary: boolean }>;
  storePatch(input: Parameters<typeof createOrReusePendingPatch>[0]): PendingPatch;
}

const defaultDependencies: DeveloperPatchProposalDependencies = {
  async inspectFile(filePath) {
    if (!(await workspacePathExists(filePath))) return { exists: false, content: "", isBinary: false };
    const file = await readWorkspaceFileForDiff(filePath);
    return { exists: true, content: file.content, isBinary: file.isBinary };
  },
  storePatch: createOrReusePendingPatch
};

export function hashDeveloperPatchContent(content: string) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function canonicalCandidateKey(candidates: DeveloperPatchCandidate[]) {
  return crypto.createHash("sha256").update(JSON.stringify(candidates.map((candidate) => ({
    path: candidate.path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(),
    operation: candidate.operation,
    newContent: candidate.newContent,
    summary: candidate.summary.trim(),
    baseContentHash: candidate.baseContentHash
  })))).digest("hex");
}

function assertCandidateShape(candidate: DeveloperPatchCandidate) {
  if (!candidate.path.trim()) throw runtimeError("INVALID_CONTRACT", "候选 Patch 包含空文件路径。");
  if (!candidate.summary.trim() || candidate.summary.length > 500) {
    throw runtimeError("INVALID_CONTRACT", `候选 Patch 缺少有效摘要：${candidate.path}`);
  }
  if (candidate.operation === "delete" && candidate.newContent !== "") {
    throw runtimeError("INVALID_CONTRACT", `删除候选的 newContent 必须为空：${candidate.path}`);
  }
}

function plannedChanges(plan: DeveloperModificationPlan) {
  return plan.files.map((file) => ({
    filePath: file.path,
    changeKind: file.operation,
    reason: file.reason
  }));
}

async function buildPatchFile(
  candidate: DeveloperPatchCandidate,
  dependencies: DeveloperPatchProposalDependencies
): Promise<PatchFileChange> {
  assertCandidateShape(candidate);
  const current = await dependencies.inspectFile(candidate.path);
  if (current.isBinary) {
    throw runtimeError("INVALID_CONTRACT", `Developer Patch-only 子图暂不接受二进制文件：${candidate.path}`);
  }
  if (candidate.operation === "create" && current.exists) {
    throw runtimeError("INVALID_CONTRACT", `create 目标已经存在：${candidate.path}`);
  }
  if (candidate.operation !== "create" && !current.exists) {
    throw runtimeError("INVALID_CONTRACT", `${candidate.operation} 目标必须是已存在文件：${candidate.path}`);
  }
  if (candidate.operation !== "create") {
    if (!candidate.baseContentHash || candidate.baseContentHash !== hashDeveloperPatchContent(current.content)) {
      throw runtimeError("INVALID_CONTRACT", `候选 Patch 的基础内容已过期：${candidate.path}`);
    }
  }

  const newContent = candidate.operation === "delete" ? "" : candidate.newContent;
  if (candidate.operation === "modify" && current.content === newContent) {
    throw runtimeError("INVALID_CONTRACT", `modify 候选没有实际变化：${candidate.path}`);
  }
  return {
    path: candidate.path,
    filePath: candidate.path,
    status: candidate.operation,
    oldContent: current.content,
    newContent,
    summary: candidate.summary.trim(),
    diffHtml: createDiffHtml(current.content, newContent),
    editHunks: createEditHunks(current.content, newContent)
  };
}

/** 生成与保存待审批 Patch；唯一允许的状态变化是内存 Pending Patch Store。 */
export async function proposeDeveloperPatch(input: {
  state: DeveloperGraphStateValue;
  candidates: DeveloperPatchCandidate[];
  taskSessionId?: string;
}, dependencies: DeveloperPatchProposalDependencies = defaultDependencies) {
  const plan = input.state.modificationPlan;
  if (!plan) throw runtimeError("INVALID_CONTRACT", "Developer 缺少结构化修改计划。");
  const gate = evaluateModificationPlan({
    task: input.state.task,
    completedTaskIds: input.state.completedTaskIds,
    evidence: input.state.evidence,
    plan
  });
  if (!gate.ready) {
    throw runtimeError("SCOPE_VIOLATION", "Developer 修改计划尚未通过范围门禁。", {
      requiredWriteScope: gate.requiredWriteScope,
      errors: gate.errors
    });
  }
  if (!input.candidates.length) throw runtimeError("INVALID_CONTRACT", "候选 Patch 不能为空。");

  const subset = validatePatchSubsetOfPlan(
    input.candidates.map((candidate) => ({ filePath: candidate.path, status: candidate.operation })),
    plannedChanges(plan)
  );
  if (!subset.ok) {
    throw runtimeError("SCOPE_VIOLATION", "候选 Patch 超出结构化修改计划。", { blockedPaths: subset.blockedFiles });
  }

  const files: PatchFileChange[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    const key = candidate.path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    if (seen.has(key)) throw runtimeError("INVALID_CONTRACT", `候选 Patch 包含重复文件：${candidate.path}`);
    seen.add(key);
    files.push(await buildPatchFile(candidate, dependencies));
  }

  const candidateKey = canonicalCandidateKey(input.candidates);
  const actionId = graphActionId(input.state.task.id, input.state.graphRunId, `propose-patch:${candidateKey}`);
  const patchId = `patch-${actionId.slice("graph-action-".length)}`;
  const evidenceIds = [...new Set(plan.files
    .filter((intent) => seen.has(intent.path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()))
    .flatMap((intent) => intent.evidenceIds))];
  const patch = dependencies.storePatch({
    patchId,
    files,
    ...(input.taskSessionId ? { taskSessionId: input.taskSessionId } : {}),
    source: {
      kind: "langgraph_developer",
      taskId: input.state.task.id,
      graphRunId: input.state.graphRunId,
      actionId,
      evidenceIds
    }
  });
  return {
    patch,
    stateUpdate: {
      status: "patch_pending_approval" as const,
      patchProposal: {
        patchId: patch.patchId,
        actionId,
        taskId: input.state.task.id,
        graphRunId: input.state.graphRunId,
        filePaths: files.map((file) => file.path)
      }
    }
  };
}

/** 将候选生成器注入节点，模型适配与 Graph 状态保持解耦。 */
export function createDeveloperPatchProposalNode(
  generateCandidates: (state: DeveloperGraphStateValue) => Promise<DeveloperPatchCandidate[]>,
  options: { taskSessionId?: string; dependencies?: DeveloperPatchProposalDependencies } = {}
) {
  return async (state: DeveloperGraphStateValue): Promise<Partial<DeveloperGraphStateValue>> => {
    const candidates = await generateCandidates(state);
    const result = await proposeDeveloperPatch(
      { state, candidates, ...(options.taskSessionId ? { taskSessionId: options.taskSessionId } : {}) },
      options.dependencies
    );
    return result.stateUpdate;
  };
}
