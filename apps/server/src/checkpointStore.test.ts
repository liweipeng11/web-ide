import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCheckpoint, getCheckpoint, rollbackCheckpoint } from "./checkpointStore.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

test("checkpoint stores tool source metadata and rolls back modified files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-checkpoint-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "before\n", "utf8");

    const checkpoint = await createCheckpoint(
      "checkpoint-source-test",
      [
        {
          filePath: "target.ts",
          oldContent: "before\n",
          newContent: "after\n",
          summary: "更新测试文件"
        }
      ],
      {
        source: {
          taskSessionId: "task-1",
          toolCallId: "tool-1",
          toolName: "applyPatch",
          actionId: "apply_patch:1",
          patchId: "patch-1",
          reason: "agent_apply_patch"
        }
      }
    );

    assert.equal(checkpoint.source?.toolCallId, "tool-1");
    assert.equal(checkpoint.files[0].beforeExists, true);

    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "after\n", "utf8");
    await rollbackCheckpoint(checkpoint.id);

    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "before\n");
    assert.equal((await getCheckpoint(checkpoint.id)).source?.toolName, "applyPatch");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("checkpoint rollback removes files created after the checkpoint", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-checkpoint-create-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const checkpoint = await createCheckpoint("checkpoint-create-test", [
      {
        filePath: "created.ts",
        oldContent: "",
        newContent: "created\n",
        summary: "创建测试文件"
      } as {
        filePath: string;
        oldContent: string;
        newContent: string;
        summary: string;
        status: "create";
      }
    ]);

    await fs.writeFile(path.join(workspaceRoot, "created.ts"), "created\n", "utf8");
    await rollbackCheckpoint(checkpoint.id);

    await assert.rejects(() => fs.readFile(path.join(workspaceRoot, "created.ts"), "utf8"), /ENOENT/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("checkpoint rollback restores files deleted by a patch", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-checkpoint-delete-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "obsolete.ts"), "before delete\n", "utf8");
    const checkpoint = await createCheckpoint("checkpoint-delete-test", [
      {
        filePath: "obsolete.ts",
        oldContent: "before delete\n",
        newContent: "",
        summary: "删除测试文件",
        status: "delete"
      }
    ]);

    await fs.rm(path.join(workspaceRoot, "obsolete.ts"));
    await rollbackCheckpoint(checkpoint.id);

    assert.equal(await fs.readFile(path.join(workspaceRoot, "obsolete.ts"), "utf8"), "before delete\n");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("checkpoint rollback restores binary files deleted by a patch", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-checkpoint-binary-delete-"));
  const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "image.png"), binaryContent);
    const checkpoint = await createCheckpoint("checkpoint-binary-delete-test", [
      {
        filePath: "image.png",
        oldContent: "",
        newContent: "",
        oldContentBase64: binaryContent.toString("base64"),
        isBinary: true,
        summary: "删除图片文件",
        status: "delete"
      }
    ]);

    await fs.rm(path.join(workspaceRoot, "image.png"));
    await rollbackCheckpoint(checkpoint.id);

    assert.deepEqual(await fs.readFile(path.join(workspaceRoot, "image.png")), binaryContent);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
