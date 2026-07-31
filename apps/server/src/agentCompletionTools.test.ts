import assert from "node:assert/strict";
import test from "node:test";
import { completeTaskToolDefinition, completionAgentToolDefinitions, parseCompleteTaskInput } from "./agentCompletionTools.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { createAgentToolRuntime, executeAgentToolCall, type AgentContext } from "./agentTools.js";

function createContext(): AgentContext {
  return {
    userGoal: "完成当前任务",
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: []
  };
}

test("completeTask schema requires summary and verified", () => {
  assert.deepEqual(completeTaskToolDefinition.parameters.required, ["summary", "verified"]);
  assert.equal(completeTaskToolDefinition.parameters.additionalProperties, false);
  assert.equal(completeTaskToolDefinition.cacheable, false);
});

test("completeTask validates and normalizes its request", () => {
  assert.deepEqual(parseCompleteTaskInput({
    summary: "  已完成实现  ",
    verified: true,
    validationSummary: "  typecheck passed  ",
    unresolvedItems: ["  waiting for deployment  "]
  }), {
    summary: "已完成实现",
    verified: true,
    validationSummary: "typecheck passed",
    unresolvedItems: ["waiting for deployment"]
  });

  assert.throws(() => parseCompleteTaskInput({ summary: "", verified: true }), /summary is required/);
  assert.throws(() => parseCompleteTaskInput({ summary: "done" }), /verified is required/);
  assert.throws(() => parseCompleteTaskInput({ summary: "done", verified: true, unresolvedItems: [""] }), /unresolvedItems/);
});

test("completeTask only returns a completion request and does not set runtime status", async () => {
  const registry = createAgentToolRegistry(completionAgentToolDefinitions);
  const result = await executeAgentToolCall({
    id: "complete-1",
    type: "function",
    function: {
      name: "completeTask",
      arguments: JSON.stringify({ summary: "实现和测试已完成", verified: true, validationSummary: "typecheck passed" })
    }
  }, createAgentToolRuntime({ agentContext: createContext(), runId: "completion-tool-test", registry }));
  const payload = JSON.parse(result.content) as Record<string, unknown>;

  assert.equal(payload.completionRequested, true);
  assert.equal(payload.summary, "实现和测试已完成");
  assert.equal("status" in payload, false);
  assert.equal("success" in payload, false);
});
