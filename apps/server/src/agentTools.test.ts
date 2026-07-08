import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentToolRuntime, executeAgentToolCall, type AgentContext, type AgentToolCall } from "./agentTools.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

function createToolCall(name: string, args: Record<string, unknown>): AgentToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function createAgentContext(): AgentContext {
  return {
    userGoal: "读取文件范围",
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: []
  };
}

test("readFileRange reads an inclusive 1-based line range with boundary metadata", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"), "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("readFileRange", { filePath: "sample.txt", startLine: 2, endLine: 4 }),
    createAgentToolRuntime({ agentContext, runId: "test-read-range" })
  );
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.content, "line 2\nline 3\nline 4");
  assert.equal(data.startLine, 2);
  assert.equal(data.endLine, 4);
  assert.equal(data.linesRead, 3);
  assert.equal(data.totalLines, 5);
  assert.equal(data.hasMoreBefore, true);
  assert.equal(data.hasMoreAfter, true);
  assert.equal(data.truncated, false);
  assert.deepEqual(agentContext.filesRead, ["sample.txt"]);
  assert.deepEqual(agentContext.relevantFiles, ["sample.txt"]);
});

test("readFileRange caps very large line ranges", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  const content = Array.from({ length: 300 }, (_item, index) => `line ${index + 1}`).join("\n");
  await fs.writeFile(path.join(workspaceRoot, "large.txt"), content, "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("readFileRange", { filePath: "large.txt", startLine: 10, endLine: 300 }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-read-range-cap" })
  );
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.startLine, 10);
  assert.equal(data.endLine, 249);
  assert.equal(data.linesRead, 240);
  assert.equal(data.totalLines, 300);
  assert.equal(data.hasMoreAfter, true);
  assert.equal(data.truncated, true);
});

test("read tools emit activity steps without an approval card", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "hello\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const steps: Array<{ type: string; actionType?: string; status?: string; toolName?: string }> = [];
  await executeAgentToolCall(
    createToolCall("readFile", { filePath: "sample.txt" }),
    createAgentToolRuntime({
      agentContext: createAgentContext(),
      runId: "test-read-approval",
      onAgentStep(step) {
        steps.push(step);
      }
    })
  );

  // 只读工具是低风险上下文活动，不再渲染成审批卡，避免和人工审批混淆。
  assert.equal(steps.some((step) => step.type === "approval_request"), false);
  assert.equal(steps[0].type, "tool_call");
  assert.equal(steps[0].toolName, "readFile");
});
