import assert from "node:assert/strict";
import test from "node:test";
import { runAgentRuntime } from "./agentRuntime.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import type { AgentCompletionResponse, AgentToolDefinition } from "./agentToolTypes.js";

function createRuntimeTestTool(name: string, result: unknown): AgentToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true
    },
    async execute() {
      return result;
    },
    summarize(value, cached) {
      return { cached, value };
    }
  };
}

test("agent runtime keeps calling model after tool results", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("readFile", { filePath: "src/a.ts", content: "hello" })]);
  const requests: Record<string, unknown>[] = [];
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-1",
                type: "function",
                function: { name: "readFile", arguments: JSON.stringify({ filePath: "src/a.ts" }) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "File read, ready to continue."
          }
        }
      ]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Analyze file",
    registry,
    runId: "test-runtime-loop",
    requestCompletion: async (body) => {
      requests.push(body);
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.content, "File read, ready to continue.");
  assert.equal(requests.length, 2);
  assert.equal(result.messages.at(-2)?.role, "tool");
});

test("agent runtime stops when tool-call step limit is reached", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);

  const result = await runAgentRuntime({
    userRequest: "Search code",
    registry,
    runId: "test-runtime-limit",
    maxSteps: 2,
    requestCompletion: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `tool-${Date.now()}-${Math.random()}`,
                type: "function",
                function: { name: "searchCode", arguments: JSON.stringify({ query: "Agent" }) }
              }
            ]
          }
        }
      ]
    })
  });

  assert.equal(result.status, "step_limit_reached");
  assert.match(result.content, /tool-call limit/);
});
