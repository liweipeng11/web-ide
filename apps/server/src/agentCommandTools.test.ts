import assert from "node:assert/strict";
import test from "node:test";
import { createCommandAgentToolDefinitions } from "./agentCommandTools.js";
import { createContextCache } from "./codeDiscovery/index.js";
import type { AgentStep, CommandPolicyResult, CommandResult } from "./types.js";

function commandResult(status: CommandResult["status"], command = "pnpm test"): CommandResult {
  return {
    command,
    cwd: "C:/workspace",
    exitCode: status === "success" || status === "running" ? 0 : 1,
    stdout: status === "success" ? "tests passed" : "",
    stderr: status === "failed" ? "tests failed" : "",
    summary: status === "success" ? "Command completed successfully." : "Command failed with exit code 1.",
    status,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

function createRuntime(onAgentStep?: (step: AgentStep) => void) {
  return {
    agentContext: {
      userGoal: "Run validation",
      filesRead: [],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: []
    },
    runId: "test-command-tool",
    cache: createContextCache(),
    onAgentStep
  };
}

function createTool(options: { policy?: CommandPolicyResult; result?: CommandResult; onRun?: () => void } = {}) {
  return createCommandAgentToolDefinitions({
    evaluateCommandPolicy: () => options.policy || { level: "safe", reason: "allowlisted" },
    runProjectCommand: async () => {
      options.onRun?.();
      return options.result || commandResult("success");
    }
  })[0];
}

function commandStatuses(steps: AgentStep[]) {
  return steps.filter((step) => step.type === "command").map((step) => (step.type === "command" ? step.status : null));
}

test("runCommand emits running and success command steps", async () => {
  const steps: AgentStep[] = [];
  const tool = createTool();
  const result = await tool.execute({ command: "pnpm test" }, createRuntime((step) => steps.push(step)));
  const summary = tool.summarize(result, false, {}) as { cached?: boolean; result?: { status?: string } };

  assert.equal(summary.cached, false);
  assert.equal(summary.result?.status, "success");
  assert.deepEqual(commandStatuses(steps), ["running", "success"]);
});

test("runCommand returns failed status details for model repair loop", async () => {
  const steps: AgentStep[] = [];
  const tool = createTool({ result: commandResult("failed") });
  const result = await tool.execute({ command: "pnpm test" }, createRuntime((step) => steps.push(step)));
  const summary = tool.summarize(result, false, {}) as { result?: { status?: string; exitCode?: number; stderr?: string } };

  assert.equal(summary.result?.status, "failed");
  assert.equal(summary.result?.exitCode, 1);
  assert.match(summary.result?.stderr || "", /tests failed/);
  assert.deepEqual(commandStatuses(steps), ["running", "failed"]);
});

test("runCommand blocks command when command policy rejects it", async () => {
  let ran = false;
  const steps: AgentStep[] = [];
  const tool = createTool({
    policy: { level: "blocked", reason: "blocked command" },
    onRun: () => {
      ran = true;
    }
  });

  await assert.rejects(() => tool.execute({ command: "rm -rf dist" }, createRuntime((step) => steps.push(step))), /blocked command/);
  assert.equal(ran, false);
  assert.deepEqual(commandStatuses(steps), ["blocked"]);
});
