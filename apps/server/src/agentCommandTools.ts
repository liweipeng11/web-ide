import { evaluateCommandPolicy } from "./commandPolicy.js";
import { runProjectCommand } from "./commandRunner.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { checkExistence } from "./existenceChecker/index.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import type { CommandPolicyResult, CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type CommandToolDependencies = {
  evaluateCommandPolicy: (command: string) => CommandPolicyResult;
  runProjectCommand: (command: string, cwd?: string, chatId?: string, confirmed?: boolean) => Promise<CommandResult>;
  verifyPackageScript: (command: string, cwd?: string) => Promise<string | null>;
};

export function parsePackageScript(command: string) {
  const tokens = command.trim().split(/\s+/);
  const packageManager = tokens.shift()?.toLowerCase();
  if (!packageManager || !["npm", "pnpm", "yarn", "bun"].includes(packageManager)) return null;

  let directory: string | undefined;
  // 支持项目分析器生成的 pnpm --dir <package> <script>，以及 npm --prefix <package> run <script>。
  while (tokens[0]?.startsWith("-")) {
    const option = tokens.shift() || "";
    const matchedDirectory = option.match(/^(?:--dir|--prefix|-C)=(.+)$/);
    if (matchedDirectory) {
      directory = matchedDirectory[1];
      continue;
    }
    if (["--dir", "--prefix", "-C"].includes(option)) {
      directory = tokens.shift();
      continue;
    }
    // 其他包管理器选项不影响脚本名，跳过其值由调用方继续按原命令执行。
  }

  if (tokens[0]?.toLowerCase() === "run") tokens.shift();
  const script = tokens[0]?.match(/^[\w:-]+$/)?.[0];
  return script ? { script, directory } : null;
}

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
      description: "Run a workspace command after user approval. Use this for validation commands such as tests, typecheck, lint, build, or a user-requested command.",
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
          }
        },
        required: ["command"],
        additionalProperties: false
      },
      async execute(args, runtime) {
        const command = requiredString(args, "command");
        const cwd = optionalString(args, "cwd") || undefined;
        const chatId = optionalString(args, "chatId") || undefined;
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
        const result = await dependencies.runProjectCommand(command, cwd, chatId, true);
        const status = result.status === "success" || result.status === "running" ? "success" : "failed";
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
