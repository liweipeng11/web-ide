import { evaluateCommandPolicy } from "../commandPolicy.js";
import { runProjectCommand } from "../commandRunner.js";
import { planVerificationCommands } from "./commandPlanner.js";
import { parseVerificationFailure } from "./failureParser.js";
import type { RunVerificationOptions, VerificationReport } from "./types.js";

export type VerifierDependencies = {
  planVerificationCommands: typeof planVerificationCommands;
  evaluateCommandPolicy: typeof evaluateCommandPolicy;
  runProjectCommand: typeof runProjectCommand;
};

const defaultDependencies: VerifierDependencies = {
  planVerificationCommands,
  evaluateCommandPolicy,
  runProjectCommand
};

function commandSucceeded(status: string | undefined) {
  return status === "success";
}

/** 顺序执行验证命令并在首个失败处短路，避免后续噪声掩盖根因。 */
export function createVerifier(dependencies: VerifierDependencies = defaultDependencies) {
  return async function verify(options: RunVerificationOptions): Promise<VerificationReport> {
    const plannedCommands = await dependencies.planVerificationCommands(options.workspaceRoot, options.preferredCommand);
    const executions: VerificationReport["executions"] = [];

    if (!plannedCommands.length) return { status: "no_commands", plannedCommands, executions };

    for (const command of plannedCommands) {
      const policy = dependencies.evaluateCommandPolicy(command.command);
      const execution = { command, policy, issues: [] };

      if (policy.level === "blocked") {
        executions.push(execution);
        return { status: "blocked", plannedCommands, executions, failedExecution: execution };
      }
      if (policy.level === "confirm" && !options.confirmed) {
        executions.push(execution);
        return { status: "needs_confirmation", plannedCommands, executions, failedExecution: execution };
      }

      const result = await dependencies.runProjectCommand(command.command, undefined, undefined, options.confirmed || policy.level === "safe");
      const completedExecution = {
        ...execution,
        result,
        issues: commandSucceeded(result.status) ? [] : parseVerificationFailure(result, command.stage)
      };
      executions.push(completedExecution);

      if (!commandSucceeded(result.status)) {
        return { status: "failed", plannedCommands, executions, failedExecution: completedExecution };
      }
    }

    return { status: "success", plannedCommands, executions };
  };
}

export const runVerification = createVerifier();
