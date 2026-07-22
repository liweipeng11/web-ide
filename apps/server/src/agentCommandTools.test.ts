import assert from "node:assert/strict";
import test from "node:test";
import { createCommandAgentToolDefinitions, parsePackageScript } from "./agentCommandTools.js";
import { createContextCache } from "./codeDiscovery/index.js";
import type { AgentToolRuntime } from "./agentToolTypes.js";
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

function createRuntime(onAgentStep?: (step: AgentStep) => void): AgentToolRuntime {
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

function createTool(options: { policy?: CommandPolicyResult; result?: CommandResult; onRun?: (runOptions?: import("./commandRunner.js").RunProjectCommandOptions) => void; scriptProblem?: string | null } = {}) {
  return createCommandAgentToolDefinitions({
    evaluateCommandPolicy: () => options.policy || { level: "safe", reason: "allowlisted" },
    runProjectCommand: async (_command, _cwd, _chatId, _confirmed, runOptions) => {
      options.onRun?.(runOptions);
      return options.result || commandResult("success");
    },
    verifyPackageScript: async () => options.scriptProblem || null
  })[0];
}

function commandStatuses(steps: AgentStep[]) {
  return steps.filter((step) => step.type === "command").map((step) => (step.type === "command" ? step.status : null));
}

test("runCommand emits running and success command steps", async () => {
  const steps: AgentStep[] = [];
  const tool = createTool();
  const runtime = createRuntime((step) => steps.push(step));
  const result = await tool.execute({ command: "pnpm test" }, runtime);
  const summary = tool.summarize(result, false, {}) as { cached?: boolean; result?: { status?: string } };

  assert.equal(summary.cached, false);
  assert.equal(summary.result?.status, "success");
  assert.deepEqual(commandStatuses(steps), ["running", "success"]);
  assert.deepEqual(runtime.agentContext.commandsRun, [{ command: "pnpm test", status: "success", exitCode: 0 }]);
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

test("runCommand 将后台模式和超时参数传给统一执行内核", async () => {
  let received: import("./commandRunner.js").RunProjectCommandOptions | undefined;
  const steps: AgentStep[] = [];
  const tool = createTool({ result: commandResult("running", "npm run dev"), onRun: (options) => { received = options; } });
  await tool.execute({ command: "npm run dev", mode: "background", waitTimeoutMs: 15000, readyPattern: "ready" }, createRuntime((step) => steps.push(step)));
  assert.deepEqual(received, { mode: "background", waitTimeoutMs: 15000, executionTimeoutMs: undefined, readyPattern: "ready" });
  assert.deepEqual(commandStatuses(steps), ["running", "running"]);
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

test("runCommand blocks missing package scripts before execution", async () => {
  let ran = false;
  const tool = createTool({ scriptProblem: 'Package script "typecheck" is missing.', onRun: () => { ran = true; } });

  await assert.rejects(() => tool.execute({ command: "pnpm typecheck" }, createRuntime()), /typecheck.*missing/i);
  assert.equal(ran, false);
});

test("识别 Monorepo 包目录中的包管理器脚本", () => {
  assert.deepEqual(parsePackageScript("pnpm --dir apps/server typecheck"), { script: "typecheck", directory: "apps/server" });
  assert.deepEqual(parsePackageScript("npm --prefix apps/server run test"), { script: "test", directory: "apps/server" });
});
