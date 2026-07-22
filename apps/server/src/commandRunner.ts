import path from "node:path";
import { HttpError } from "./errors.js";
import { saveCommandResult } from "./commandResults.js";
import type { CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { evaluateCommandPolicy } from "./commandPolicy.js";
import { classifyCommand } from "./commandExecution/commandClassifier.js";
import { parseCommandOutput } from "./commandExecution/commandOutputParser.js";
import { commandExecutionService } from "./commandExecution/index.js";

const commandTimeoutMs = 120_000;

export type RunProjectCommandOptions = {
  mode?: "foreground" | "background" | "auto";
  waitTimeoutMs?: number;
  executionTimeoutMs?: number;
  readyPattern?: string;
  initiator?: "agent" | "validation" | "user";
  ci?: boolean;
};

export function resolveCommandCwd(cwd?: string) {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    throw new HttpError(400, "Open a workspace before running commands");
  }

  if (!cwd?.trim()) return workspaceRoot;

  const nextCwd = path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(workspaceRoot, cwd);
  const relative = path.relative(workspaceRoot, nextCwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Command working directory must stay inside the workspace");
  }
  return nextCwd;
}

/** 保留旧调用契约，内部统一委托给服务端 execution 内核。 */
export async function runProjectCommand(command: string, cwd?: string, chatId?: string, confirmed = false, options: RunProjectCommandOptions = {}) {
  const trimmedCommand = command.trim();
  if (!trimmedCommand) throw new HttpError(400, "command is required");

  const resolvedCwd = resolveCommandCwd(cwd);
  const policy = evaluateCommandPolicy(trimmedCommand);
  if (policy.level === "blocked") throw new HttpError(403, policy.reason);
  if (policy.level === "confirm" && !confirmed) throw new HttpError(409, policy.reason);

  const longRunning = classifyCommand(trimmedCommand).kind === "long_running";
  const requestedMode = options.mode ?? "auto";
  const mode = requestedMode === "auto" ? (longRunning ? "background" : "foreground") : requestedMode;
  const started = await commandExecutionService.start({
    command: trimmedCommand,
    cwd: resolvedCwd,
    chatId,
    mode,
    initiator: options.initiator ?? "user",
    ci: options.ci,
    // 长期服务由调用方主动停止；一次性命令仍保留原有 120 秒执行上限。
    executionTimeoutMs: options.executionTimeoutMs ?? (mode === "background" ? undefined : commandTimeoutMs),
    readyPattern: options.readyPattern
  });
  const execution = await commandExecutionService.waitForState(started.id, {
    until: mode === "background" ? "ready_or_finished" : "finished",
    timeoutMs: options.waitTimeoutMs ?? (mode === "background" ? 15_000 : commandTimeoutMs),
    killOnTimeout: false
  });
  const { stdout, stderr } = commandExecutionService.readCapturedOutput(started.id);
  const summary = parseCommandOutput({
    command: trimmedCommand,
    exitCode: execution.exitCode,
    stdout,
    stderr,
    timedOut: execution.waitTimedOut || execution.failureReason === "execution_timeout",
    timeoutMs: commandTimeoutMs,
    longRunning
  });
  const status: CommandResult["status"] =
    execution.state === "running" && (execution.readiness === "ready" || execution.interaction.state === "needs_input")
      ? "running"
      : execution.state === "cancelled"
        ? "cancelled"
      : execution.waitTimedOut || execution.failureReason === "execution_timeout"
        ? "timeout"
        : execution.state === "succeeded"
          ? "success"
          : "failed";
  const result: CommandResult = {
    executionId: execution.id,
    command: trimmedCommand,
    chatId,
    cwd: resolvedCwd,
    exitCode: execution.exitCode,
    stdout: summary.stdout,
    stderr: summary.stderr,
    summary: summary.summary,
    status,
    detectedUrl: execution.readyUrl ?? summary.detectedUrl,
    detectedUrls: execution.detectedUrls,
    waitTimedOut: execution.waitTimedOut,
    outputTruncated: execution.outputTruncated || summary.outputTruncated,
    readiness: execution.readiness,
    interaction: execution.interaction,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt ?? new Date().toISOString()
  };

  // Agent 默认只接收压缩后的有界输出；完整日志始终保存在 execution 独立日志文件中供 UI 查看。
  const modelOutput = await commandExecutionService.getOutputSummary(started.id);
  result.stdout = modelOutput.output;
  result.stderr = "";
  result.summary = modelOutput.summary;
  result.outputTruncated = result.outputTruncated || modelOutput.truncated;

  await saveCommandResult(result);
  return result;
}
