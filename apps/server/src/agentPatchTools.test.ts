import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchAgentToolDefinitions } from "./agentPatchTools.js";
import { createContextCache } from "./codeDiscovery/index.js";
import { getCheckpoint } from "./checkpointStore.js";
import { clearPendingPatches, createPendingPatch, getPendingPatch } from "./patchStore.js";
import { runtimeAgentToolRegistry } from "./runtimeAgentTools.js";
import type { AgentToolRuntime } from "./agentToolTypes.js";
import type { AgentStep, PatchFileChange } from "./types.js";
import { setWorkspaceRoot } from "./workspaceStore.js";
import { buildSafeEditRecommendation, evaluateSafeEdit } from "./safeEditor/index.js";

function createToolRuntime(options: Partial<AgentToolRuntime> = {}): AgentToolRuntime {
  return {
    agentContext: {
      userGoal: "apply generated patch",
      filesRead: [],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: []
    },
    runId: "test-agent-patch-tool",
    cache: createContextCache(),
    ...options
  };
}

test("runtime registry exposes patch tools for continuous agent runs", () => {
  assert.ok(runtimeAgentToolRegistry.get("proposePatch"));
  assert.ok(runtimeAgentToolRegistry.get("applyPatch"));
});

test("applyPatch tool applies a pending patch and removes it from the store", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-patch-tool-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");

    const change: PatchFileChange = {
      path: "target.ts",
      filePath: "target.ts",
      status: "modify",
      oldContent: "export const value = 1;\n",
      newContent: "export const value = 2;\n",
      summary: "Update constant value",
      diffHtml: ""
    };
    const patch = createPendingPatch([change]);
    const tool = patchAgentToolDefinitions.find((definition) => definition.name === "applyPatch");
    const steps: AgentStep[] = [];

    assert.ok(tool);
    const result = (await tool.execute(
      { patchId: patch.patchId },
      createToolRuntime({
        taskSessionId: "task-agent-patch",
        currentToolCall: {
          id: "tool-apply-1",
          name: "applyPatch",
          arguments: { patchId: patch.patchId },
          actionId: "apply_patch:test"
        },
        onAgentStep(step) {
          steps.push(step);
        }
      })
    )) as { checkpoint?: { id?: string }; files?: Array<{ path: string }> };

    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(getPendingPatch(patch.patchId), null);
    const checkpointId = result.checkpoint?.id || "";

    assert.ok(checkpointId);
    assert.notEqual(checkpointId, patch.patchId);
    assert.deepEqual(result.files?.map((file) => file.path), ["target.ts"]);
    const checkpoint = await getCheckpoint(checkpointId);

    assert.equal(checkpoint.source?.patchId, patch.patchId);
    assert.equal(checkpoint.source?.toolCallId, "tool-apply-1");
    assert.equal(steps.some((step) => step.type === "checkpoint" && step.checkpointId === checkpointId), true);
  } finally {
    clearPendingPatches();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("applyPatch tool requires explicit acknowledgement for Safe Editor high-risk changes", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-safe-patch-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    const change: PatchFileChange = { path: "target.ts", filePath: "target.ts", status: "modify", oldContent: "export const value = 1;\n", newContent: "export const value = 2;\n", summary: "Update value", diffHtml: "" };
    const safeEditReport = evaluateSafeEdit({ taskDescription: "更新数值", recommendation: buildSafeEditRecommendation({}), candidates: [change] });
    const patch = createPendingPatch([change], undefined, undefined, {
      rawPatchCount: 1, normalizedFilePaths: ["target.ts"], preDedupeCount: 1, postDedupeCount: 1, finalPatchCount: 1,
      filteredCount: 0, noEffectCount: 0, records: [], safeEditReport, generatedAt: Date.now()
    });
    const tool = patchAgentToolDefinitions.find((definition) => definition.name === "applyPatch");

    assert.ok(tool);
    await assert.rejects(() => tool.execute({ patchId: patch.patchId }, createToolRuntime()), /explicit confirmation/i);
    assert.ok(getPendingPatch(patch.patchId));
    await tool.execute(
      { patchId: patch.patchId },
      createToolRuntime({ currentToolCall: { id: "approved-safe-apply", name: "applyPatch", arguments: { patchId: patch.patchId }, actionId: "apply_patch:approved" } })
    );
    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "export const value = 2;\n");
  } finally {
    clearPendingPatches();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("applyPatch tool rejects delete patches so deletion must use command approval", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-delete-patch-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "obsolete.ts"), "export const obsolete = true;\n", "utf8");

    const change: PatchFileChange = {
      path: "obsolete.ts",
      filePath: "obsolete.ts",
      status: "delete",
      oldContent: "export const obsolete = true;\n",
      newContent: "",
      summary: "Delete obsolete file",
      diffHtml: ""
    };
    const patch = createPendingPatch([change]);
    const tool = patchAgentToolDefinitions.find((definition) => definition.name === "applyPatch");

    assert.ok(tool);
    await assert.rejects(() => tool.execute({ patchId: patch.patchId }, createToolRuntime()), /Delete patches are disabled/);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "obsolete.ts"), "utf8"), "export const obsolete = true;\n");
    assert.ok(getPendingPatch(patch.patchId));
  } finally {
    clearPendingPatches();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("applyPatch tool rejects binary delete patches before deleting content", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-delete-binary-patch-"));
  const binaryContent = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x00]);

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await fs.writeFile(path.join(workspaceRoot, "archive.zip"), binaryContent);

    const change: PatchFileChange = {
      path: "archive.zip",
      filePath: "archive.zip",
      status: "delete",
      oldContent: "",
      newContent: "",
      oldContentBase64: binaryContent.toString("base64"),
      isBinary: true,
      summary: "Delete archive file",
      diffHtml: "Binary file will be deleted. Content preview is hidden."
    };
    const patch = createPendingPatch([change]);
    const tool = patchAgentToolDefinitions.find((definition) => definition.name === "applyPatch");

    assert.ok(tool);
    await assert.rejects(() => tool.execute({ patchId: patch.patchId }, createToolRuntime()), /Delete patches are disabled/);
    assert.deepEqual(await fs.readFile(path.join(workspaceRoot, "archive.zip")), binaryContent);
    assert.ok(getPendingPatch(patch.patchId));
  } finally {
    clearPendingPatches();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
