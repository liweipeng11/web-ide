import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { executeAgentToolCall } from "./agentTools.js";
import { fileEditToolDefinitions } from "./fileEditTools.js";
import { runtimeAgentToolRegistry } from "./runtimeAgentTools.js";
import { setWorkspaceRoot } from "./workspaceStore.js";
import type { AgentFileEditToolResult, AgentToolRuntime } from "./agentToolTypes.js";
import type { AgentStep } from "./types.js";

function createToolRuntime(options: Partial<AgentToolRuntime> = {}): AgentToolRuntime & { registry: typeof runtimeAgentToolRegistry } {
  return {
    agentContext: {
      userGoal: "edit files with direct tools",
      filesRead: [],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: []
    },
    runId: "test-agent-file-edit-tool",
    cache: new Map(),
    registry: runtimeAgentToolRegistry,
    ...options
  };
}

async function withTempWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-file-edit-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("runtime registry 同时暴露新编辑工具和旧 patch 工具", () => {
  assert.ok(runtimeAgentToolRegistry.get("replaceInFile"));
  assert.ok(runtimeAgentToolRegistry.get("writeFile"));
  assert.ok(runtimeAgentToolRegistry.get("proposePatch"));
  assert.ok(runtimeAgentToolRegistry.get("applyPatch"));
});

test("replaceInFile 工具会写入文件并返回 finalContent", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "replaceInFile");

    assert.ok(tool);
    const result = (await tool.execute(
      {
        filePath: "target.ts",
        search: "value = 1",
        replace: "value = 2"
      },
      createToolRuntime()
    )) as AgentFileEditToolResult;

    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(result.filePath, "target.ts");
    assert.equal(result.changed, true);
    assert.equal(result.replacements, 1);
    assert.equal(result.oldContentPreview, "export const value = 1;\n");
    assert.equal(result.finalContent, "export const value = 2;\n");
  });
});

test("writeFile 工具支持创建新文件并返回 finalContent", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "writeFile");

    assert.ok(tool);
    const result = (await tool.execute(
      {
        filePath: "src/new-file.ts",
        content: "export const created = true;\n",
        createIfMissing: true
      },
      createToolRuntime()
    )) as AgentFileEditToolResult;

    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "new-file.ts"), "utf8"), "export const created = true;\n");
    assert.equal(result.filePath, "src/new-file.ts");
    assert.equal(result.changed, true);
    assert.equal(result.oldContentPreview, "");
    assert.equal(result.finalContent, "export const created = true;\n");
  });
});

test("executeAgentToolCall 会为编辑工具产生日志步骤和工具结果", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "const name = 'old';\n", "utf8");
    const steps: AgentStep[] = [];

    const message = await executeAgentToolCall(
      {
        id: "tool-replace-1",
        type: "function",
        function: {
          name: "replaceInFile",
          arguments: JSON.stringify({
            filePath: "target.ts",
            search: "old",
            replace: "new"
          })
        }
      },
      createToolRuntime({
        emitToolApprovalSteps: true,
        onAgentStep(step) {
          steps.push(step);
        }
      })
    );
    const content = JSON.parse(message.content) as AgentFileEditToolResult;
    const resultStep = steps.find((step) => step.type === "tool_result" && step.toolName === "replaceInFile");

    assert.equal(content.finalContent, "const name = 'new';\n");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "const name = 'new';\n");
    assert.ok(steps.some((step) => step.type === "approval_request" && step.actionType === "edit_files"));
    assert.ok(resultStep);
    if (resultStep.type !== "tool_result") {
      throw new Error("Expected a tool_result step for replaceInFile");
    }
    assert.equal((resultStep.output as { finalContent?: string }).finalContent, "const name = 'new';\n");
  });
});
