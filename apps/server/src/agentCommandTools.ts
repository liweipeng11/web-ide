import { evaluateCommandPolicy } from "./commandPolicy.js";
import { runProjectCommand } from "./commandRunner.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import type { CommandPolicyResult, CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { parsePackageScript } from "./commandExecution/commandClassifier.js";
import { resolvePackageScriptExecution } from "./commandExecution/packageScriptResolver.js";
import type { RunProjectCommandOptions } from "./commandRunner.js";

export { parsePackageScript } from "./commandExecution/commandClassifier.js";

type CommandToolDependencies = {
  evaluateCommandPolicy: (command: string) => CommandPolicyResult;
  runProjectCommand: (command: string, cwd?: string, chatId?: string, confirmed?: boolean, options?: RunProjectCommandOptions) => Promise<CommandResult>;
  resolvePackageScriptCwd: (command: string, cwd?: string) => Promise<string | undefined>;
};

async function resolvePackageScriptCwd(command: string, cwd?: string) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return cwd;
  return (await resolvePackageScriptExecution(workspaceRoot, command, cwd)).cwd;
}

const defaultDependencies: CommandToolDependencies = {
  evaluateCommandPolicy,
  runProjectCommand,
  resolvePackageScriptCwd
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

function isValidationCommand(command: string) {
  // 仅将测试、类型检查、构建和静态检查视为验证，避免把 ls/search 等普通命令误记为通过。
  const packageScript = parsePackageScript(command)?.script.toLowerCase();
  const scriptIsValidation = packageScript
    ? ["test", "typecheck", "lint", "build", "check", "compile"].includes(packageScript.split(":")[0] || "")
    : false;
  return scriptIsValidation
    || /(?:^|[\s:&|;])(?:test|typecheck|lint|build|check|compile)(?=$|[\s:&|;])/i.test(command)
    || /(?:^|[\s:&|;])(?:tsc|pytest|vitest|jest|mocha)(?=$|[\s:&|;])/i.test(command)
    || /(?:^|[\s:&|;])(?:go|cargo|dotnet)\s+test(?=$|[\s:&|;])/i.test(command)
    || /--test(?:\s|$)/i.test(command);
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
        let effectiveCwd: string | undefined;
        try {
          // 包脚本必须先解析到确定目录；多包歧义时禁止依赖模型猜测。
          effectiveCwd = await dependencies.resolvePackageScriptCwd(command, cwd);
        } catch (error) {
          runtime.onAgentStep?.(createAgentStep({ type: "command", command, policy, status: "blocked", result: null }));
          throw error;
        }

        // Runtime 已经完成用户审批，这里仍传 confirmed=true，让 commandRunner 复用原有二次策略校验。
        runtime.onAgentStep?.(createAgentStep({ type: "command", command, policy, status: "running", result: null }));
        const result = await dependencies.runProjectCommand(command, effectiveCwd, chatId, true, { mode, waitTimeoutMs, executionTimeoutMs, readyPattern, initiator: "agent" });
        // ready 的后台服务仍是 running，不把“可以继续下一步”伪装成进程已成功退出。
        const status = result.status === "success"
          ? "success"
          : result.status === "running"
            ? "running"
            : result.status === "cancelled"
              ? "cancelled"
              : "failed";
        runtime.agentContext.commandsRun = [
          ...(runtime.agentContext.commandsRun || []),
          {
            command,
            status,
            exitCode: result.exitCode,
            validation: isValidationCommand(command),
            finishedAt: status === "running" ? undefined : Date.now()
          }
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
