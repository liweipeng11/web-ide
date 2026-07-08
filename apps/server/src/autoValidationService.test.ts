import assert from "node:assert/strict";
import test from "node:test";
import { createAutoValidationRunner, type AutoValidationDependencies } from "./autoValidationService.js";
import type { AgentStep, CommandPolicyResult, CommandResult, GenerateEditResponse, TaskSession } from "./types.js";

function commandResult(status: CommandResult["status"], command = "pnpm test"): CommandResult {
  return {
    command,
    cwd: "C:/workspace",
    exitCode: status === "success" ? 0 : 1,
    stdout: status === "success" ? "tests passed" : "",
    stderr: status === "success" ? "" : "1 test failed",
    status,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

function patchResponse(taskSessionId = "task-1"): GenerateEditResponse {
  return {
    taskSessionId,
    patchId: "patch-1",
    modelSummary: "Repair failing test",
    finalSummary: "已生成 0 个文件的修改，并已附带建议验证命令。",
    rawPatchCount: 0,
    finalPatchCount: 0,
    summary: "已生成 0 个文件的修改，并已附带建议验证命令。",
    files: [],
    commandsToRun: ["pnpm test"],
    diffHtml: "",
    oldContent: "",
    newContent: ""
  };
}

function createHarness(options: { policy?: CommandPolicyResult; result?: CommandResult } = {}) {
  const statuses: TaskSession["status"][] = [];
  const progressPhases: string[] = [];
  const storedSteps: AgentStep[] = [];
  const patchCalls: Array<{ selectedPath: string | null | undefined; prompt: string; taskSessionId?: string }> = [];
  let commandCalls = 0;
  const dependencies = {
    evaluateCommandPolicy: () => options.policy || { level: "safe", reason: "test allowlist" },
    runProjectCommand: async () => {
      commandCalls += 1;
      return options.result || commandResult("success");
    },
    createEditPatchResponse: async (selectedPath, prompt, onAgentStep, taskSessionId) => {
      patchCalls.push({ selectedPath, prompt, taskSessionId });
      onAgentStep?.({ id: "edit-step", createdAt: 1, type: "edit", files: ["src/app.ts"] });
      return patchResponse(taskSessionId);
    },
    appendTaskSessionStep: async (_taskSessionId, step) => {
      storedSteps.push(step);
      return null;
    },
    advanceTaskPlanProgress: async (_taskSessionId, phase) => {
      progressPhases.push(phase);
      return null;
    },
    updateTaskSessionStatus: async (_taskSessionId, status) => {
      statuses.push(status);
      return null;
    }
  } as AutoValidationDependencies;

  return {
    run: createAutoValidationRunner(dependencies),
    statuses,
    storedSteps,
    progressPhases,
    patchCalls,
    commandCalls: () => commandCalls
  };
}

test("stops successfully when validation passes", async () => {
  const harness = createHarness();
  const result = await harness.run({ command: "pnpm test", taskSessionId: "task-1" });

  assert.equal(result.status, "success");
  assert.equal(harness.commandCalls(), 1);
  assert.deepEqual(harness.progressPhases, ["validation_success"]);
  assert.deepEqual(harness.statuses, ["success"]);
  assert.equal(harness.patchCalls.length, 0);
  assert.deepEqual(
    result.agentSteps.filter((step) => step.type === "command").map((step) => step.status),
    ["running", "success"]
  );
});

test("requires confirmation before running an unknown command", async () => {
  const harness = createHarness({ policy: { level: "confirm", reason: "unknown command" } });
  const result = await harness.run({ command: "custom-check", taskSessionId: "task-1" });

  assert.equal(result.status, "needs_confirmation");
  assert.equal(harness.commandCalls(), 0);
  assert.deepEqual(harness.statuses, []);
  assert.equal(result.agentSteps[0]?.type, "command");
  assert.equal(result.agentSteps[0]?.type === "command" ? result.agentSteps[0].status : null, "cancelled");
});

test("generates a reviewable repair patch after failed validation", async () => {
  const harness = createHarness({ result: commandResult("failed") });
  const result = await harness.run({ command: "pnpm test", selectedPath: "src/app.ts", taskSessionId: "task-1", attempts: 0, maxAttempts: 3 });

  assert.equal(result.status, "fix_generated");
  assert.equal(result.attempts, 1);
  assert.equal(result.patch?.patchId, "patch-1");
  assert.deepEqual(harness.progressPhases, ["validation_failed"]);
  assert.deepEqual(harness.statuses, []);
  assert.equal(harness.patchCalls.length, 1);
  assert.equal(harness.patchCalls[0].selectedPath, "src/app.ts");
  assert.equal(harness.patchCalls[0].taskSessionId, "task-1");
  assert.match(harness.patchCalls[0].prompt, /1 test failed/);
  assert.match(harness.patchCalls[0].prompt, /commandsToRun must include the same validation command/);
  assert.equal(harness.storedSteps.some((step) => step.type === "edit"), true);
});

test("stops and marks the task failed after the retry limit", async () => {
  const harness = createHarness({ result: commandResult("failed") });
  const result = await harness.run({ command: "pnpm test", taskSessionId: "task-1", attempts: 3, maxAttempts: 3 });

  assert.equal(result.status, "max_attempts_reached");
  assert.equal(result.attempts, 3);
  assert.deepEqual(harness.progressPhases, ["validation_failed"]);
  assert.deepEqual(harness.statuses, ["failed"]);
  assert.equal(harness.patchCalls.length, 0);
  assert.equal(result.agentSteps.some((step) => step.type === "error"), true);
});
