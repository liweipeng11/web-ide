import { evaluateCommandPolicy } from "../commandPolicy.js";
import { runProjectCommand } from "../commandRunner.js";
import { planVerification } from "./commandPlanner.js";
import { parseVerificationFailure } from "./failureParser.js";
import type { RunVerificationOptions, VerificationReport } from "./types.js";

export type VerifierDependencies = {
  planVerification: typeof planVerification;
  evaluateCommandPolicy: typeof evaluateCommandPolicy;
  runProjectCommand: typeof runProjectCommand;
};

const defaultDependencies: VerifierDependencies = {
  planVerification,
  evaluateCommandPolicy,
  runProjectCommand
};

function commandSucceeded(status: string | undefined) {
  return status === "success";
}

/** 顺序执行验证命令并在首个失败处短路，避免后续噪声掩盖根因。 */
export function createVerifier(dependencies: VerifierDependencies = defaultDependencies) {
  return async function verify(options: RunVerificationOptions): Promise<VerificationReport> {
    const plan = await dependencies.planVerification(options.workspaceRoot, options.preferredCommand, {
      changedFiles: options.changedFiles,
      failureCategories: options.failureCategories
    });
    const plannedCommands = plan.commands;
    const executions: VerificationReport["executions"] = [];

    if (!plannedCommands.length) return { status: "no_commands", plannedCommands, plan, executions };

    for (const command of plannedCommands) {
      const policy = dependencies.evaluateCommandPolicy(command.command);
      const execution = { command, policy, issues: [] };

      if (policy.level === "blocked") {
        executions.push(execution);
        return { status: "blocked", plannedCommands, plan, executions, failedExecution: execution };
      }
      if (policy.level === "confirm" && !options.confirmed) {
        executions.push(execution);
        return { status: "needs_confirmation", plannedCommands, plan, executions, failedExecution: execution };
      }

      const result = await dependencies.runProjectCommand(command.command, undefined, undefined, options.confirmed || policy.level === "safe", {
        initiator: "validation",
        // 仅验证计划中的构建、测试、检查命令使用 CI，避免改变开发服务器行为。
        ci: true,
        signal: options.signal
      });
      const completedExecution = {
        ...execution,
        result,
        issues: commandSucceeded(result.status) ? [] : parseVerificationFailure(result, command.stage)
      };
      executions.push(completedExecution);

      if (!commandSucceeded(result.status)) {
        // 用户主动停止验证时保留取消语义，不进入普通失败和自动回修流程。
        return { status: result.status === "cancelled" ? "cancelled" : "failed", plannedCommands, plan, executions, failedExecution: completedExecution };
      }
    }

    return { status: "success", plannedCommands, plan, executions };
  };
}

export const runVerification = createVerifier();
