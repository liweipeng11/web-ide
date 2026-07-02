import assert from "node:assert/strict";
import test from "node:test";
import { resumeAgentRuntimeAfterApproval, runAgentRuntime } from "./agentRuntime.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import type { AgentCompletionResponse, AgentToolDefinition } from "./agentToolTypes.js";

function createRuntimeTestTool(name: string, result: unknown, onExecute?: () => void): AgentToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true
    },
    async execute() {
      onExecute?.();
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

test("agent runtime pauses before approval-required tools", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const steps: Array<{ type: string; status?: string; actionType?: string }> = [];

  const result = await runAgentRuntime({
    userRequest: "Run tests",
    registry,
    runId: "test-runtime-approval",
    onAgentStep(step) {
      steps.push({ type: step.type, status: step.type === "approval_request" ? step.status : undefined, actionType: step.type === "approval_request" ? step.actionType : undefined });
    },
    requestCompletion: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-command-1",
                type: "function",
                function: { name: "runCommand", arguments: JSON.stringify({ command: "pnpm test" }) }
              }
            ]
          }
        }
      ]
    })
  });

  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.pendingToolCall?.toolName, "runCommand");
  assert.equal(result.pendingToolCall?.riskLevel, "medium");
  assert.equal(executed, false);
  assert.deepEqual(steps, [{ type: "approval_request", status: "pending", actionType: "run_command" }]);
});

test("agent runtime feeds blocked unknown tools back to the model", async () => {
  const registry = createAgentToolRegistry([]);
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "unknown-tool-1",
                type: "function",
                function: { name: "missingTool", arguments: JSON.stringify({}) }
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
            content: "Cannot use that tool, so I will stop."
          }
        }
      ]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Call unknown tool",
    registry,
    runId: "test-runtime-blocked-tool",
    requestCompletion: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.equal(result.status, "completed");
  assert.match(result.messages.find((message) => message.role === "tool")?.content || "", /Unknown tool/);
  assert.equal(result.content, "Cannot use that tool, so I will stop.");
});

test("agent runtime resumes after approving a pending tool call", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const result = await resumeAgentRuntimeAfterApproval({
    userRequest: "Run tests",
    registry,
    runId: "test-runtime-resume-approved",
    pendingToolCall: {
      actionId: "run_command:test-action",
      toolCallId: "tool-command-1",
      toolName: "runCommand",
      arguments: { command: "pnpm test" },
      riskLevel: "medium",
      status: "pending",
      createdAt: Date.now()
    },
    persistedMessages: [
      {
        id: "assistant-tool-call",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tool-command-1", name: "runCommand", arguments: { command: "pnpm test" } }],
        createdAt: Date.now()
      }
    ],
    decision: "approved",
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "Command result handled." } }]
    })
  });

  assert.equal(executed, true);
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Command result handled.");
  assert.equal(result.messages.some((message) => message.role === "tool" && /exitCode/.test(message.content || "")), true);
});

test("agent runtime resumes after rejecting a pending tool call", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const result = await resumeAgentRuntimeAfterApproval({
    userRequest: "Run tests",
    registry,
    runId: "test-runtime-resume-rejected",
    pendingToolCall: {
      actionId: "run_command:test-action",
      toolCallId: "tool-command-1",
      toolName: "runCommand",
      arguments: { command: "pnpm test" },
      riskLevel: "medium",
      status: "pending",
      createdAt: Date.now()
    },
    persistedMessages: [
      {
        id: "assistant-tool-call",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tool-command-1", name: "runCommand", arguments: { command: "pnpm test" } }],
        createdAt: Date.now()
      }
    ],
    decision: "rejected",
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "I will continue without that command." } }]
    })
  });

  assert.equal(executed, false);
  assert.equal(result.status, "completed");
  assert.equal(result.content, "I will continue without that command.");
  assert.match(result.messages.find((message) => message.role === "tool")?.content || "", /rejected/);
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
