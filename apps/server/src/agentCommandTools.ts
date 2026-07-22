import { evaluateCommandPolicy } from "./commandPolicy.js";
import { runProjectCommand } from "./commandRunner.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { checkExistence } from "./existenceChecker/index.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import type { CommandPolicyResult, CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { parsePackageScript } from "./commandExecution/commandClassifier.js";
import type { RunProjectCommandOptions } from "./commandRunner.js";

export { parsePackageScript } from "./commandExecution/commandClassifier.js";

type CommandToolDependencies = {
  evaluateCommandPolicy: (command: string) => CommandPolicyResult;
  runProjectCommand: (command: string, cwd?: string, chatId?: string, confirmed?: boolean, options?: RunProjectCommandOptions) => Promise<CommandResult>;
  verifyPackageScript: (command: string, cwd?: string) => Promise<string | null>;
};

async function verifyPackageScript(command: string, cwd?: string) {
  const parsed = parsePackageScript(command);
  if (!parsed) return null;
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return null;
  const packageDirectory = parsed.directory || cwd;
  const result = await checkExistence(workspaceRoot, [{ kind: "script", value: parsed.script, ...(packageDirectory ? { fromPath: `${packageDirectory.replace(/[\\/]+$/, "")}/package.json` } : {}) }]);
  const check = result.checks[0];
  return check?.status === "exists" ? null : `Package script "${parsed.script}" is ${check?.status || "missing"}.`;
}

const defaultDependencies: CommandToolDependencies = {
  evaluateCommandPolicy,
  runProjectCommand,
  verifyPackageScript
};

function optionalString(args: Record<string, unknown>, name: string) {
  return typeof args[name] === "string" && args[name].trim() ? args[name].trim() : null;
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = optionalString(args, name);

  if (!value) {
    throw new Error(name + " is required");
  }

  return value;
}

function optionalPositiveNumber(args: Record<string, unknown>, name: string) {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be greater than zero`);
  return value;
}

function summarizeOutput(value: string, maxLength = 4000) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function createCommandSummary(result: CommandResult) {
  return {
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    exitCode: result.exitCode,
    detectedUrl: result.detectedUrl,
    outputTruncated: result.outputTruncated,
    summary: result.summary,
    stdout: summarizeOutput(result.stdout || ""),
    stderr: summarizeOutput(result.stderr || "")
  };
}

export function createCommandAgentToolDefinitions(dependencies: CommandToolDependencies = defaultDependencies): AgentToolDefinition[] {
  return [
    {
      name: "runCommand",
      description: "Run a workspace command after user approval. Use foreground for tests/lint/typecheck/build, background for dev/serve/watch and wait for readiness, or auto when uncertain. Never extend timeouts indefinitely to imitate background mode.",
      cacheable: false,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Command to execute inside the workspace."
          },
          cwd: {
            type: "string",
            description: "Optional workspace-relative working directory. Defaults to the workspace root."
          },
          chatId: {
            type: "string",
            description: "Optional chat id used to associate command results with the current conversation."
          },
          mode: {
            type: "string",
            enum: ["foreground", "background", "auto"],
            description: "Execution mode. Background returns when the service is ready instead of waiting for process exit."
          },
          waitTimeoutMs: {
            type: "number",
            description: "Maximum time to synchronously wait for completion or readiness. Defaults to 15000 for background services."
          },
          executionTimeoutMs: {
            type: "number",
            description: "Maximum process lifetime. Usually omit for background services."
          },
          readyPattern: {
            type: "string",
            description: "Optional regular expression that explicitly identifies service readiness in output."
          }
        },
        required: ["command"],
        additionalProperties: false
      },
      async execute(args, runtime) {
        const command = requiredString(args, "command");
        const cwd = optionalString(args, "cwd") || undefined;
        const chatId = optionalString(args, "chatId") || undefined;
        const rawMode = optionalString(args, "mode");
        if (rawMode && !["foreground", "background", "auto"].includes(rawMode)) throw new Error("mode must be foreground, background, or auto");
        const mode = rawMode as RunProjectCommandOptions["mode"];
        const waitTimeoutMs = optionalPositiveNumber(args, "waitTimeoutMs");
        const executionTimeoutMs = optionalPositiveNumber(args, "executionTimeoutMs");
        const readyPattern = optionalString(args, "readyPattern") || undefined;
        const policy = dependencies.evaluateCommandPolicy(command);

        if (policy.level === "blocked") {
          runtime.onAgentStep?.(createAgentStep({ type: "command", command, policy, status: "blocked", result: null }));
          throw new Error(policy.reason);
        }
        const scriptProblem = await dependencies.verifyPackageScript(command, cwd);
        if (scriptProblem) {
          runtime.onAgentStep?.(createAgentStep({ type: "command", command, policy, status: "blocked", result: null }));
          throw new Error(scriptProblem);
        }

        // Runtime 已经完成用户审批，这里仍传 confirmed=true，让 commandRunner 复用原有二次策略校验。
        runtime.onAgentStep?.(createAgentStep({ type: "command", command, policy, status: "running", result: null }));
        const result = await dependencies.runProjectCommand(command, cwd, chatId, true, { mode, waitTimeoutMs, executionTimeoutMs, readyPattern, initiator: "agent" });
        // ready 的后台服务仍是 running，不把“可以继续下一步”伪装成进程已成功退出。
        const status = result.status === "success" ? "success" : result.status === "running" ? "running" : "failed";
        runtime.agentContext.commandsRun = [
          ...(runtime.agentContext.commandsRun || []),
          { command, status, exitCode: result.exitCode }
        ];
        runtime.onAgentStep?.(createAgentStep({ type: "command", command, policy, status, result }));

        return {
          policy,
          result
        };
      },
      summarize(value, cached) {
        const result = value && typeof value === "object" && !Array.isArray(value) ? (value as { policy?: CommandPolicyResult; result?: CommandResult }) : {};

        return {
          cached,
          policy: result.policy,
          result: result.result ? createCommandSummary(result.result) : null
        };
      }
    }
  ];
}

export const commandAgentToolDefinitions = createCommandAgentToolDefinitions();
