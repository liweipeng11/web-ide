import { createEditPatchResponse } from "./editPatchService.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { advanceTaskPlanProgress, appendTaskSessionPatchEvent, appendTaskSessionStep, updateTaskSessionStatus } from "./taskSessionStore.js";
import type { AgentStep, AutoValidationResponse, CommandResult } from "./types.js";
import { runVerification } from "./verifier/index.js";
import type { VerificationIssueCategory, VerificationReport } from "./verifier/types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { RunMetricsTracker } from "./observability/index.js";
import { createAiRunId } from "./aiHttp.js";
import { config } from "./config.js";

const defaultMaxAttempts = 3;
const maxFailurePromptChars = 6_000;

function clampAttemptCount(value: unknown) {
  const count = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(0, count);
}

function clampMaxAttempts(value: unknown) {
  const count = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : defaultMaxAttempts;
  // 自动回修最多三轮，避免错误方向导致无限生成补丁。
  return Math.min(3, Math.max(1, count));
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

function summarizeIssues(report: VerificationReport) {
  const issues = report.failedExecution?.issues || [];
  if (!issues.length) return "(未提取到结构化错误)";

  return issues
    .map((issue) => {
      const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""}` : "未定位文件";
      return `- [${issue.category}] ${location}${issue.code ? ` ${issue.code}` : ""}: ${issue.message}`;
    })
    .join("\n");
}

function buildFixPrompt(result: CommandResult, report: VerificationReport, attempts: number, maxAttempts: number) {
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
    "Structured issues:",
    summarizeIssues(report),
    "",
    "Failure output:",
    tail(summarizeCommandFailure(result), maxFailurePromptChars)
  ].join("\n");
}

function commandSucceeded(result: CommandResult) {
  return result.status === "success" || (result.status === "running" && Boolean(result.detectedUrl));
}

export type AutoValidationOptions = {
  command?: string | null;
  selectedPath?: string | null;
  taskSessionId?: string | null;
  attempts?: number;
  maxAttempts?: number;
  changedFiles?: string[];
  failureCategories?: VerificationIssueCategory[];
  confirmed?: boolean;
};

export type AutoValidationDependencies = {
  runVerification: typeof runVerification;
  getWorkspaceRoot: typeof getWorkspaceRoot;
  createEditPatchResponse: typeof createEditPatchResponse;
  appendTaskSessionStep: typeof appendTaskSessionStep;
  appendTaskSessionPatchEvent?: typeof appendTaskSessionPatchEvent;
  advanceTaskPlanProgress: typeof advanceTaskPlanProgress;
  updateTaskSessionStatus: typeof updateTaskSessionStatus;
  createMetricsTracker?: (taskSessionId: string | null) => RunMetricsTracker;
};

const defaultDependencies: AutoValidationDependencies = {
  runVerification,
  getWorkspaceRoot,
  createEditPatchResponse,
  appendTaskSessionStep,
  appendTaskSessionPatchEvent,
  advanceTaskPlanProgress,
  updateTaskSessionStatus,
  createMetricsTracker: (taskSessionId) => new RunMetricsTracker({
    runId: createAiRunId("validation"),
    taskSessionId,
    provider: "local",
    model: config.aiModel,
    mode: "validation",
    scope: "validation_run"
  })
};

export function createAutoValidationRunner(dependencies: AutoValidationDependencies = defaultDependencies) {
  return async function run(options: AutoValidationOptions): Promise<AutoValidationResponse> {
    const requestedCommand = options.command?.trim() || null;
    const attempts = clampAttemptCount(options.attempts);
    const maxAttempts = clampMaxAttempts(options.maxAttempts);
    const taskSessionId = options.taskSessionId || undefined;
    const metrics = dependencies.createMetricsTracker?.(taskSessionId ?? null);
    const agentSteps: AgentStep[] = [];
    const taskStepWrites: Promise<unknown>[] = [];
    const pushAgentStep = (step: AgentStep) => {
      agentSteps.push(step);
      taskStepWrites.push(dependencies.appendTaskSessionStep(taskSessionId, step));
    };
    const finish = async (response: AutoValidationResponse) => {
      await Promise.all(taskStepWrites);
      const commandCount = response.verification?.executions.length ?? 0;
      const validationStatus = response.status === "success" ? "passed" : ["blocked", "max_attempts_reached", "fix_generated"].includes(response.status) ? "failed" : "not_run";
      await metrics?.finish({
        status: ["blocked", "max_attempts_reached"].includes(response.status) ? "failed" : "completed",
        failureCategory: validationStatus === "failed" ? "validation_failure" : "none",
        patchFileCount: response.patch?.files.length ?? 0,
        validationCommandCount: commandCount,
        validationStatus
      });
      return response;
    };
    const workspaceRoot = dependencies.getWorkspaceRoot();
    if (!workspaceRoot) throw new Error("Open a workspace before running validation");

    const verification = await dependencies.runVerification({
      workspaceRoot,
      preferredCommand: requestedCommand,
      changedFiles: options.changedFiles,
      failureCategories: options.failureCategories,
      confirmed: options.confirmed
    });
    const activeExecution = verification.failedExecution || verification.executions.at(-1);
    const command = activeExecution?.command.command || requestedCommand || "";
    const policy = activeExecution?.policy || { level: "blocked" as const, reason: "未发现可执行的验证命令" };
    const result = activeExecution?.result;

    // 将流水线内每条命令映射为现有 Agent 步骤，保持任务历史和前端展示兼容。
    for (const execution of verification.executions) {
      if (execution.result) {
        pushAgentStep(createAgentStep({ type: "command", command: execution.command.command, policy: execution.policy, status: "running", result: null }));
        pushAgentStep(createAgentStep({ type: "command", command: execution.command.command, policy: execution.policy, status: commandSucceeded(execution.result) ? "success" : "failed", result: execution.result }));
      } else {
        pushAgentStep(createAgentStep({
          type: "command",
          command: execution.command.command,
          policy: execution.policy,
          status: execution.policy.level === "blocked" ? "blocked" : "cancelled",
          result: null
        }));
      }
    }

    if (verification.status === "no_commands") {
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
      await dependencies.updateTaskSessionStatus(taskSessionId, "awaiting_user");
      return finish({ status: "no_commands", command, attempts, maxAttempts, policy, verification, agentSteps });
    }

    if (verification.status === "blocked") {
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
      await dependencies.updateTaskSessionStatus(taskSessionId, "failed");
      return finish({ status: "blocked", command, attempts, maxAttempts, policy, verification, agentSteps });
    }

    if (verification.status === "needs_confirmation") {
      return finish({ status: "needs_confirmation", command, attempts, maxAttempts, policy, verification, agentSteps });
    }

    if (verification.status === "success") {
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_success");
      await dependencies.updateTaskSessionStatus(taskSessionId, "success");
      return finish({ status: "success", command, attempts, maxAttempts, policy, result, verification, agentSteps });
    }

    if (!result) throw new Error("验证失败，但没有可用于回修的命令结果");

    const nextAttempt = attempts + 1;
    const failureSummary = summarizeCommandFailure(result);

    if (nextAttempt > maxAttempts) {
      pushAgentStep(createAgentStep({ type: "error", message: `Auto-fix stopped after ${maxAttempts} failed repair attempts for: ${command}` }));
      await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
      await dependencies.updateTaskSessionStatus(taskSessionId, "failed");
      return finish({ status: "max_attempts_reached", command, attempts: maxAttempts, maxAttempts, policy, result, verification, failureSummary, agentSteps });
    }

    pushAgentStep(createAgentStep({ type: "message", content: `Validation failed. Generating repair patch ${nextAttempt}/${maxAttempts} for: ${command}` }));
    await dependencies.advanceTaskPlanProgress(taskSessionId, "validation_failed");
    const patch = await dependencies.createEditPatchResponse(options.selectedPath, buildFixPrompt(result, verification, nextAttempt, maxAttempts), pushAgentStep, taskSessionId);
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
      verification,
      patch: { ...patch, agentSteps },
      failureSummary,
      agentSteps
    });
  };
}

export const runAutoValidation = createAutoValidationRunner();
