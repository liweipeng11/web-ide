import { createEditPatchResponse } from "./editPatchService.js";
import { evaluateCommandPolicy } from "./commandPolicy.js";
import { runProjectCommand } from "./commandRunner.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { advanceTaskPlanProgress, appendTaskSessionPatchEvent, appendTaskSessionStep, updateTaskSessionStatus } from "./taskSessionStore.js";
import type { AgentStep, AutoValidationResponse, CommandResult } from "./types.js";

const defaultMaxAttempts = 3;
const maxFailurePromptChars = 6_000;

function clampAttemptCount(value: unknown) {
  const count = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, count);
}

function clampMaxAttempts(value: unknown) {
  const count = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : defaultMaxAttempts;
  return Math.min(5, Math.max(1, count));
}

function tail(value: string | undefined, maxLength: number) {
  if (!value) return "";
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function summarizeCommandFailure(result: CommandResult) {
  const outputPreview = [
    result.summary && `summary:\n${tail(result.summary, 2_000)}`,
    result.stderr && `stderr tail:\n${tail(result.stderr, 2_000)}`,
    result.stdout && `stdout tail:\n${tail(result.stdout, 2_000)}`
  ]
    .filter(Boolean)
    .join("\n\n");

  return [
    `Command: ${result.command}`,
    `CWD: ${result.cwd}`,
    `Status: ${result.status || "unknown"}`,
    `Exit code: ${result.exitCode ?? "null"}`,
    "",
    outputPreview || "(no output)"
  ].join("\n");
}

function buildFixPrompt(result: CommandResult, attempts: number, maxAttempts: number) {
  return [
    "Automatic validation failed. Generate a new repair patch from the command output below.",
    "",
    `This is repair attempt ${attempts}/${maxAttempts}.`,
    `Validation command: ${result.command}`,
    "",
    "Requirements:",
    "- Change only code related to the validation failure.",
    "- Keep the fix minimal and follow existing project patterns.",
    "- Return a reviewable patch and do not claim the command was run.",
    "- commandsToRun must include the same validation command.",
    "",
    "Failure output:",
    tail(summarizeCommandFailure(result), maxFailurePromptChars)
  ].join("\n");
}

function commandSucceeded(result: CommandResult) {
  return result.status === "success" || (result.status === "running" && Boolean(result.detectedUrl));
}

export type AutoValidationOptions = {
  command: string;
  selectedPath?: string | null;
  taskSessionId?: string | null;
  attempts?: number;
  maxAttempts?: number;
  confirmed?: boolean;
};

export type AutoValidationDependencies = {
  evaluateCommandPolicy: typeof evaluateCommandPolicy;
  runProjectCommand: typeof runProjectCommand;
  createEditPatchResponse: typeof createEditPatchResponse;
  appendTaskSessionStep: typeof appendTaskSessionStep;
  appendTaskSessionPatchEvent?: typeof appendTaskSessionPatchEvent;
  advanceTaskPlanProgress: typeof advanceTaskPlanProgress;
  updateTaskSessionStatus: typeof updateTaskSessionStatus;
};

const defaultDependencies: AutoValidationDependencies = {
  evaluateCommandPolicy,
  runProjectCommand,
  createEditPatchResponse,
  appendTaskSessionStep,
  appendTaskSessionPatchEvent,
  advanceTaskPlanProgress,
  updateTaskSessionStatus
};

export function createAutoValidationRunner(dependencies: AutoValidationDependencies = defaultDependencies) {
  return async function run(options: AutoValidationOptions): Promise<AutoValidationResponse> {
    const command = options.command.trim();
    const attempts = clampAttemptCount(options.attempts);
    const maxAttempts = clampMaxAttempts(options.maxAttempts);
    const taskSessionId = options.taskSessionId || undefined;
    const agentSteps: AgentStep[] = [];
    const taskStepWrites: Promise<unknown>[] = [];
    const pushAgentStep = (step: AgentStep) => {
      agentSteps.push(step);
      taskStepWrites.push(dependencies.appendTaskSessionStep(taskSessionId, step));
    };
    const finish = async (response: AutoValidationResponse) => {
      await Promise.all(taskStepWrites);
      return response;
    };
    const policy = dependencies.evaluateCommandPolicy(command);

    if (policy.level === "blocked") {
      pushAgentStep(createAgentStep({ type: "command", command, policy, status: "blocked", result: null }));
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
      await dependencies.updateTaskSessionStatus(taskSessionId, "failed");
      return finish({ status: "blocked", command, attempts, maxAttempts, policy, agentSteps });
    }

    if (policy.level === "confirm" && !options.confirmed) {
      pushAgentStep(createAgentStep({ type: "command", command, policy, status: "cancelled", result: null }));
      return finish({ status: "needs_confirmation", command, attempts, maxAttempts, policy, agentSteps });
    }

    pushAgentStep(createAgentStep({ type: "command", command, policy, status: "running", result: null }));
    const result = await dependencies.runProjectCommand(command, undefined, undefined, options.confirmed || policy.level === "safe");
    pushAgentStep(createAgentStep({ type: "command", command, policy, status: commandSucceeded(result) ? "success" : "failed", result }));

    if (commandSucceeded(result)) {
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_success");
      await dependencies.updateTaskSessionStatus(taskSessionId, "success");
      return finish({ status: "success", command, attempts, maxAttempts, policy, result, agentSteps });
    }

    const nextAttempt = attempts + 1;
    const failureSummary = summarizeCommandFailure(result);

    if (nextAttempt > maxAttempts) {
      pushAgentStep(createAgentStep({ type: "error", message: `Auto-fix stopped after ${maxAttempts} failed repair attempts for: ${command}` }));
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
      await dependencies.updateTaskSessionStatus(taskSessionId, "failed");
      return finish({ status: "max_attempts_reached", command, attempts: maxAttempts, maxAttempts, policy, result, failureSummary, agentSteps });
    }

    pushAgentStep(createAgentStep({ type: "message", content: `Validation failed. Generating repair patch ${nextAttempt}/${maxAttempts} for: ${command}` }));
    await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
    const patch = await dependencies.createEditPatchResponse(options.selectedPath, buildFixPrompt(result, nextAttempt, maxAttempts), pushAgentStep, taskSessionId);
    await dependencies.appendTaskSessionPatchEvent?.(taskSessionId, {
      type: "auto_fix_patch_created",
      patchId: patch.patchId,
      filePaths: patch.files.map((file) => file.path),
      command,
      attempt: nextAttempt,
      message: `验证失败后生成第 ${nextAttempt} 轮自动修复 patch。`,
      detail: {
        maxAttempts,
        failureSummary
      }
    });

    return finish({
      status: "fix_generated",
      command,
      attempts: nextAttempt,
      maxAttempts,
      policy,
      result,
      patch: { ...patch, agentSteps },
      failureSummary,
      agentSteps
    });
  };
}

export const runAutoValidation = createAutoValidationRunner();
