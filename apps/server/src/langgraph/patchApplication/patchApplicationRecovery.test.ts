import assert from "node:assert/strict";
import test from "node:test";
import type { Checkpoint } from "../../types.js";
import { recoverPatchApplication, type PatchApplicationRecoveryDependencies } from "./patchApplicationRecovery.js";
import type { PatchApprovalStateValue } from "./patchApprovalState.js";

function state(): PatchApprovalStateValue {
  return {
    taskSessionId: "session-1",
    taskId: "I1",
    graphRunId: "run-1",
    patchId: "patch-1",
    proposalActionId: "proposal-1",
    approvalActionId: "approval-1",
    applyActionId: "apply-1",
    filePaths: ["src/a.ts", "src/new.ts"],
    requestedAt: 100,
    expiresAt: 1_000,
    status: "approved",
    decidedAt: 200,
    resolutionSource: "user",
    application: null
  };
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "checkpoint-1",
    taskId: "patch-1",
    createdAt: 300,
    source: {
      taskSessionId: "session-1",
      patchId: "patch-1",
      actionId: "apply-1"
    },
    files: [
      {
        filePath: "src/a.ts",
        beforeContent: "before",
        afterContent: "after",
        beforeExists: true,
        afterExists: true
      },
      {
        filePath: "src/new.ts",
        beforeContent: "",
        afterContent: "created",
        beforeExists: false,
        afterExists: true
      }
    ],
    ...overrides
  };
}

function dependencies(currentFiles: Record<string, string | null>, checkpoints = [checkpoint()]): PatchApplicationRecoveryDependencies {
  return {
    findCheckpoints: async () => checkpoints,
    pathExists: async (filePath) => currentFiles[filePath] !== null && currentFiles[filePath] !== undefined,
    readText: async (filePath) => {
      const content = currentFiles[filePath];
      if (typeof content !== "string") throw new Error(`文件不存在：${filePath}`);
      return content;
    },
    readBuffer: async (filePath) => Buffer.from(currentFiles[filePath] ?? "")
  };
}

test("没有关联 Checkpoint 时判定为尚未应用", async () => {
  const result = await recoverPatchApplication(state(), dependencies({}, []));
  assert.deepEqual(result, { status: "not_applied", checkpointIds: [] });
});

test("Checkpoint 全部匹配 after 内容时恢复稳定应用回执", async () => {
  const result = await recoverPatchApplication(state(), dependencies({
    "src/a.ts": "after",
    "src/new.ts": "created"
  }));

  assert.equal(result.status, "applied");
  if (result.status !== "applied") return;
  assert.equal(result.receipt.checkpointId, "checkpoint-1");
  assert.equal(result.receipt.actionId, "apply-1");
  assert.equal(result.receipt.recoveredFromCheckpoint, true);
});

test("Checkpoint 已创建但磁盘仍全部匹配 before 时允许正常重试", async () => {
  const result = await recoverPatchApplication(state(), dependencies({
    "src/a.ts": "before",
    "src/new.ts": null
  }));

  assert.deepEqual(result, { status: "not_applied", checkpointIds: ["checkpoint-1"] });
});

test("部分文件写入或内容漂移时停止恢复而不盲目重写", async () => {
  await assert.rejects(
    () => recoverPatchApplication(state(), dependencies({
      "src/a.ts": "after",
      "src/new.ts": null
    })),
    /部分完成或内容已漂移/
  );
  await assert.rejects(
    () => recoverPatchApplication(state(), dependencies({
      "src/a.ts": "external-change",
      "src/new.ts": null
    })),
    /部分完成或内容已漂移/
  );
});

test("相同 action 关联其他 Patch 或文件集合时拒绝恢复", async () => {
  await assert.rejects(
    () => recoverPatchApplication(state(), dependencies({}, [checkpoint({ taskId: "other-patch" })])),
    /其他任务或 Patch/
  );
  await assert.rejects(
    () => recoverPatchApplication(state(), dependencies({}, [checkpoint({
      files: [checkpoint().files[0]]
    })])),
    /文件集合.*不一致/
  );
});
