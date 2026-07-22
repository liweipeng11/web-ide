import { spawn } from "node:child_process";
import path from "node:path";
import { HttpError } from "./errors.js";
import { saveCommandResult } from "./commandResults.js";
import type { CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { evaluateCommandPolicy } from "./commandPolicy.js";
import { classifyCommand } from "./commandExecution/commandClassifier.js";
import { parseCommandOutput } from "./commandExecution/commandOutputParser.js";

const maxCapturedOutputLength = 80_000;
const commandTimeoutMs = 120_000;

function appendOutput(current: string, chunk: string) {
  const next = current + chunk;

  if (next.length <= maxCapturedOutputLength) {
    return next;
  }

  return next.slice(next.length - maxCapturedOutputLength);
}

function resolveCommandCwd(cwd?: string) {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    throw new HttpError(400, "Open a workspace before running commands");
  }

  if (!cwd?.trim()) {
    return workspaceRoot;
  }

  const nextCwd = path.isAbsolute(cwd) ? path.resolve(cwd) : path.resolve(workspaceRoot, cwd);
  const relative = path.relative(workspaceRoot, nextCwd);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "Command working directory must stay inside the workspace");
  }

  return nextCwd;
}

export async function runProjectCommand(command: string, cwd?: string, chatId?: string, confirmed = false) {
  const trimmedCommand = command.trim();

  if (!trimmedCommand) {
    throw new HttpError(400, "command is required");
  }

  const resolvedCwd = resolveCommandCwd(cwd);
  const policy = evaluateCommandPolicy(trimmedCommand);

  if (policy.level === "blocked") {
    throw new HttpError(403, policy.reason);
  }

  if (policy.level === "confirm" && !confirmed) {
    throw new HttpError(409, policy.reason);
  }

  const startedAt = new Date().toISOString();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(trimmedCommand, {
      cwd: resolvedCwd,
      shell: true,
      env: process.env
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      stderr = appendOutput(stderr, `\nCommand timed out after ${commandTimeoutMs / 1000} seconds and was stopped.\n`);
      child.kill();
    }, commandTimeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk.toString("utf8"));
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(timedOut ? null : code);
    });
  });

  const summary = parseCommandOutput({
    command: trimmedCommand,
    exitCode,
    stdout,
    stderr,
    timedOut,
    timeoutMs: commandTimeoutMs,
    longRunning: classifyCommand(trimmedCommand).kind === "long_running"
  });
  const result: CommandResult = {
    command: trimmedCommand,
    chatId,
    cwd: resolvedCwd,
    exitCode,
    stdout: summary.stdout,
    stderr: summary.stderr,
    summary: summary.summary,
    status: summary.status,
    detectedUrl: summary.detectedUrl,
    detectedUrls: summary.detectedUrls,
    waitTimedOut: timedOut,
    outputTruncated: summary.outputTruncated,
    startedAt,
    finishedAt: new Date().toISOString()
  };

  await saveCommandResult(result);
  return result;
}
