import { evaluateCommandPolicy } from "../commandPolicy.js";
import { runProjectCommand } from "../commandRunner.js";
import { planVerification } from "./commandPlanner.js";
import { parseVerificationFailure } from "./failureParser.js";
import type { RunVerificationOptions, VerificationPlan, VerificationReport } from "./types.js";

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

export type ExecuteVerificationPlanOptions = {
  confirmed?: boolean;
  signal?: AbortSignal;
};

export type VerificationExecutorDependencies = Pick<VerifierDependencies, "evaluateCommandPolicy" | "runProjectCommand">;

/** 执行已经通过门禁的既定计划；恢复运行时不会重新扫描项目或改变命令集合。 */
export async function executeVerificationPlan(
  plan: VerificationPlan,
  options: ExecuteVerificationPlanOptions = {},
  dependencies: VerificationExecutorDependencies = defaultDependencies
): Promise<VerificationReport> {
  const plannedCommands = plan.commands;
  const executions: VerificationReport["executions"] = [];

  if (!plannedCommands.length) return { status: "no_commands", plannedCommands, plan, executions };

  for (const command of plannedCommands) {
    // 执行边界再次检查策略，防止 checkpoint 恢复期间策略收紧后仍运行旧命令。
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

    const result = await dependencies.runProjectCommand(
      command.command,
      undefined,
      undefined,
      options.confirmed || policy.level === "safe",
      { initiator: "validation", ci: true, signal: options.signal }
    );
    const completedExecution = {
      ...execution,
      result,
      issues: commandSucceeded(result.status) ? [] : parseVerificationFailure(result, command.stage)
    };
    executions.push(completedExecution);
    if (!commandSucceeded(result.status)) {
      return {
        status: result.status === "cancelled" ? "cancelled" : "failed",
        plannedCommands,
        plan,
        executions,
        failedExecution: completedExecution
      };
    }
  }
  return { status: "success", plannedCommands, plan, executions };
}

/** 顺序执行验证命令并在首个失败处短路，避免后续噪声掩盖根因。 */
export function createVerifier(dependencies: VerifierDependencies = defaultDependencies) {
  return async function verify(options: RunVerificationOptions): Promise<VerificationReport> {
    const plan = await dependencies.planVerification(options.workspaceRoot, options.preferredCommand, {
      changedFiles: options.changedFiles,
      failureCategories: options.failureCategories
    });
    return executeVerificationPlan(plan, options, dependencies);
  };
}

export const runVerification = createVerifier();
