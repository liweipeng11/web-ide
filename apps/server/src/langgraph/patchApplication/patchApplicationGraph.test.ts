import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Checkpoint, PendingPatch } from "../../types.js";
import { TaskSessionCheckpointer } from "../persistence/taskSessionCheckpointer.js";
import {
  createPatchApplicationGraph,
  runPatchApplicationGraph
} from "./patchApplicationGraph.js";
import type { PatchApplicationRecoveryDependencies } from "./patchApplicationRecovery.js";
import type { PatchApplyNodeDependencies } from "./patchApplyNode.js";
import type { PatchApprovalStateValue } from "./patchApprovalState.js";

function approvedState(): PatchApprovalStateValue {
  return {
    taskSessionId: "session-1",
    taskId: "I1",
    graphRunId: "run-1",
    patchId: "patch-1",
    proposalActionId: "proposal-1",
    approvalActionId: "approval-1",
    applyActionId: "apply-1",
    filePaths: ["src/index.ts"],
    requestedAt: 100,
    expiresAt: 1_000,
    status: "approved",
    decidedAt: 200,
    resolutionSource: "user",
    application: null
  };
}

function pendingPatch(): PendingPatch {
  return {
    patchId: "patch-1",
    taskSessionId: "session-1",
    createdAt: 100,
    files: [{
      path: "src/index.ts",
      filePath: "src/index.ts",
      status: "modify",
      oldContent: "before",
      newContent: "after",
      summary: "修改入口",
      diffHtml: "diff"
    }],
    source: {
      kind: "langgraph_developer",
      taskId: "I1",
      graphRunId: "run-1",
      actionId: "proposal-1",
      evidenceIds: ["evidence-1"]
    }
  };
}

function checkpoint(): Checkpoint {
  return {
    id: "checkpoint-1",
    taskId: "patch-1",
    createdAt: 300,
    source: { taskSessionId: "session-1", patchId: "patch-1", actionId: "apply-1" },
    files: [{
      filePath: "src/index.ts",
      beforeContent: "before",
      afterContent: "after",
      beforeExists: true,
      afterExists: true
    }]
  };
}

test("应用图持久化回执，新 Graph 实例重放时不重复执行副作用", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-patch-graph-"));
  let applyCalls = 0;
  let diskContent = "before";
  const patch = pendingPatch();
  const applyDependencies: PatchApplyNodeDependencies = {
    getPatch: () => patch,
    applyPatch: async () => {
      applyCalls += 1;
      diskContent = "after";
      return {
        checkpoint: checkpoint(),
        patchId: patch.patchId,
        files: [{ path: "src/index.ts", status: "modify", summary: "修改入口" }]
      };
    },
    now: () => 400,
    recoverApplication: async () => ({ status: "not_applied", checkpointIds: [] })
  };
  const recoveryDependencies: PatchApplicationRecoveryDependencies = {
    findCheckpoints: async () => [],
    pathExists: async () => true,
    readText: async () => diskContent,
    readBuffer: async () => Buffer.from(diskContent)
  };

  try {
    const first = createPatchApplicationGraph({
      checkpointer: new TaskSessionCheckpointer(directory),
      writeScope: ["src/**"],
      applyDependencies,
      recoveryDependencies
    });
    const receipt = await runPatchApplicationGraph(first, approvedState());
    assert.equal(receipt.checkpointId, "checkpoint-1");

    // 新 checkpointer 与新 Graph 模拟服务重启，终态从磁盘恢复而不是再次 apply。
    const restarted = createPatchApplicationGraph({
      checkpointer: new TaskSessionCheckpointer(directory),
      writeScope: ["src/**"],
      applyDependencies,
      recoveryDependencies
    });
    const replay = await runPatchApplicationGraph(restarted, approvedState());
    assert.deepEqual(replay, receipt);
    assert.equal(applyCalls, 1);

    await assert.rejects(
      () => runPatchApplicationGraph(restarted, { ...approvedState(), status: "rejected", resolutionSource: "user" }),
      /明确批准/
    );
    await assert.rejects(
      () => runPatchApplicationGraph(restarted, { ...approvedState(), patchId: "forged-patch" }),
      /回执与当前审批状态不一致/
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("写入完成但 Graph 状态未保存时，通过文件 Checkpoint 恢复且不盲目重写", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-patch-recover-"));
  let applyCalls = 0;
  const state = approvedState();
  const recoveredCheckpoint = checkpoint();
  const applyDependencies: PatchApplyNodeDependencies = {
    getPatch: () => pendingPatch(),
    applyPatch: async () => {
      applyCalls += 1;
      throw new Error("不应重复应用");
    },
    now: () => 400
  };
  const recoveryDependencies: PatchApplicationRecoveryDependencies = {
    findCheckpoints: async () => [recoveredCheckpoint],
    pathExists: async () => true,
    readText: async () => "after",
    readBuffer: async () => Buffer.from("after")
  };

  try {
    const graph = createPatchApplicationGraph({
      checkpointer: new TaskSessionCheckpointer(directory),
      writeScope: ["src/**"],
      applyDependencies,
      recoveryDependencies
    });
    const receipt = await runPatchApplicationGraph(graph, state);
    assert.equal(receipt.recoveredFromCheckpoint, true);
    assert.equal(receipt.checkpointId, "checkpoint-1");
    assert.equal(applyCalls, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
