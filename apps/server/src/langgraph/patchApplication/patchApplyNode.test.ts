import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearPendingPatches, createOrReusePendingPatch, getPendingPatch } from "../../patchStore.js";
import { createTaskSession } from "../../taskSessionStore.js";
import type { Checkpoint, PendingPatch } from "../../types.js";
import { setWorkspaceRoot } from "../../workspaceStore.js";
import type { DeveloperPatchProposalReference } from "../developer/developerGraphState.js";
import { resolvePatchApproval } from "./patchApprovalDecision.js";
import { applyApprovedPatchNode, createPatchApplyNode, type PatchApplyNodeDependencies } from "./patchApplyNode.js";
import { createPatchApprovalState, type PatchApprovalStateValue } from "./patchApprovalState.js";

async function fixture(context: { after(callback: () => void | Promise<void>): void }) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-patch-apply-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src/index.ts"), "export const value = 1;\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  clearPendingPatches();
  context.after(async () => {
    clearPendingPatches();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  const session = await createTaskSession("应用已审批 Patch");
  const proposal: DeveloperPatchProposalReference = {
    patchId: "patch-apply-node",
    actionId: "graph-action-proposal",
    taskId: "I1",
    graphRunId: "run-1",
    filePaths: ["src/index.ts"]
  };
  const patch = createOrReusePendingPatch({
    patchId: proposal.patchId,
    taskSessionId: session.id,
    files: [{
      path: "src/index.ts",
      filePath: "src/index.ts",
      status: "modify",
      oldContent: "export const value = 1;\n",
      newContent: "export const value = 2;\n",
      summary: "更新入口",
      diffHtml: "diff"
    }],
    source: {
      kind: "langgraph_developer",
      taskId: proposal.taskId,
      graphRunId: proposal.graphRunId,
      actionId: proposal.actionId,
      evidenceIds: ["existence", "impact"]
    }
  });
  const pending = createPatchApprovalState({
    taskSessionId: session.id,
    patch,
    proposal,
    requestedAt: 100,
    expiresAt: 1_000
  });
  const approved = resolvePatchApproval(pending, {
    actionId: pending.approvalActionId,
    decision: "approved",
    decidedAt: 200
  }).state;
  return { workspaceRoot, patch, pending, approved };
}

function fakeResult(patch: PendingPatch, filePaths = patch.files.map((file) => file.path)) {
  const checkpoint: Checkpoint = {
    id: "checkpoint-1",
    taskId: patch.patchId,
    createdAt: 300,
    files: []
  };
  return {
    checkpoint,
    patchId: patch.patchId,
    files: filePaths.map((filePath) => ({ path: filePath, status: "modify" as const, summary: "测试" }))
  };
}

test("未批准、错误 action 或 writeScope 越权时不会调用 Patch Apply", async (context) => {
  const { patch, pending, approved } = await fixture(context);
  let calls = 0;
  const dependencies: PatchApplyNodeDependencies = {
    getPatch: () => patch,
    applyPatch: async () => {
      calls += 1;
      return fakeResult(patch);
    },
    now: () => 400
  };

  await assert.rejects(
    () => applyApprovedPatchNode({ state: pending, actionId: pending.applyActionId, writeScope: ["src/**"] }, dependencies),
    /明确批准/
  );
  await assert.rejects(
    () => applyApprovedPatchNode({ state: approved, actionId: "forged", writeScope: ["src/**"] }, dependencies),
    /actionId 不匹配/
  );
  await assert.rejects(
    () => applyApprovedPatchNode({ state: approved, actionId: approved.applyActionId, writeScope: ["docs/**"] }, dependencies),
    /应用前.*writeScope/
  );
  assert.equal(calls, 0);
});

test("Patch 来源或已审批文件集合漂移时在写入前拒绝", async (context) => {
  const { patch, approved } = await fixture(context);
  let calls = 0;
  const dependencies: PatchApplyNodeDependencies = {
    getPatch: () => ({
      ...patch,
      source: patch.source ? { ...patch.source, graphRunId: "forged-run" } : undefined
    }),
    applyPatch: async () => {
      calls += 1;
      return fakeResult(patch);
    },
    now: () => 400
  };

  await assert.rejects(
    () => applyApprovedPatchNode({ state: approved, actionId: approved.applyActionId, writeScope: ["src/**"] }, dependencies),
    /来源已经漂移/
  );
  assert.equal(calls, 0);
});

test("批准后通过现有 Patch Apply 写入精确内容并返回 Checkpoint 回执", async (context) => {
  const { workspaceRoot, patch, approved } = await fixture(context);
  const receipt = await applyApprovedPatchNode({
    state: approved,
    actionId: approved.applyActionId,
    writeScope: ["src/**"]
  });

  assert.equal(await fs.readFile(path.join(workspaceRoot, "src/index.ts"), "utf8"), "export const value = 2;\n");
  assert.equal(receipt.actionId, approved.applyActionId);
  assert.equal(receipt.patchId, patch.patchId);
  assert.deepEqual(receipt.filePaths, ["src/index.ts"]);
  assert.ok(receipt.checkpointId);
  assert.equal(receipt.recoveredFromCheckpoint, false);
  assert.equal(getPendingPatch(patch.patchId), null);

  // 模拟 Graph 状态保存失败或服务重启：只保留审批状态，依靠文件 Checkpoint 恢复回执。
  const recovered = await applyApprovedPatchNode({
    state: approved,
    actionId: approved.applyActionId,
    writeScope: ["src/**"]
  });
  assert.equal(recovered.checkpointId, receipt.checkpointId);
  assert.equal(recovered.recoveredFromCheckpoint, true);
});

test("Graph 节点返回 application state update，已有回执重放时不重复应用", async (context) => {
  const { patch, approved } = await fixture(context);
  let calls = 0;
  const dependencies: PatchApplyNodeDependencies = {
    getPatch: () => patch,
    applyPatch: async () => {
      calls += 1;
      return fakeResult(patch);
    },
    now: () => 400
  };
  const node = createPatchApplyNode({ writeScope: ["src/**"], dependencies });
  const update = await node(approved);
  assert.equal(update.application?.checkpointId, "checkpoint-1");

  const replay = await applyApprovedPatchNode({
    state: { ...approved, application: update.application ?? null },
    actionId: approved.applyActionId,
    writeScope: ["src/**"]
  }, dependencies);
  assert.equal(replay, update.application);
  assert.equal(calls, 1);

  await assert.rejects(
    () => applyApprovedPatchNode({
      state: { ...approved, status: "rejected", application: update.application ?? null },
      actionId: approved.applyActionId,
      writeScope: ["src/**"]
    }, dependencies),
    /明确批准/
  );
  await assert.rejects(
    () => applyApprovedPatchNode({
      state: { ...approved, application: update.application ?? null },
      actionId: approved.applyActionId,
      writeScope: ["docs/**"]
    }, dependencies),
    /应用后.*writeScope/
  );
});

test("Patch Apply 返回越权文件时执行后校验失败", async (context) => {
  const { patch, approved } = await fixture(context);
  const dependencies: PatchApplyNodeDependencies = {
    getPatch: () => patch,
    applyPatch: async () => fakeResult(patch, ["src/index.ts", "outside.txt"]),
    now: () => 400
  };

  await assert.rejects(
    () => applyApprovedPatchNode({ state: approved, actionId: approved.applyActionId, writeScope: ["src/**"] }, dependencies),
    /应用后.*writeScope/
  );
});

test("Pending Patch 缺失时不把缺失误判为已成功应用", async (context) => {
  const { approved } = await fixture(context);
  const dependencies: PatchApplyNodeDependencies = {
    getPatch: () => null,
    applyPatch: async () => {
      throw new Error("不应调用");
    },
    now: () => 400
  };

  await assert.rejects(
    () => applyApprovedPatchNode({ state: approved, actionId: approved.applyActionId, writeScope: ["src/**"] }, dependencies),
    /不能推断其已经成功写入/
  );
});
