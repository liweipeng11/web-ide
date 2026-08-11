import type { AcceptanceEvidenceInput, TesterArtifact } from "./agents/tester/contracts.js";
import type { TesterExecution, TesterTaskOptions } from "./agents/tester/testerAgentRuntime.js";
import { MainAgentRuntime } from "./agents/main/mainAgentRuntime.js";
import { runtimeError } from "./runtime/errors.js";
import { recordTaskSessionTesterExecution } from "./taskSessionStore.js";
import type { TaskSession } from "./types.js";

type TesterRuntimeFacade = Pick<MainAgentRuntime, "executeTestTask">;

export type ApprovedTesterExecutionResult =
  | { outcome: "not_applicable"; reason: string }
  | {
      outcome: "executed";
      execution: TesterExecution;
      artifact: TesterArtifact;
      session: TaskSession;
    };

function createArtifact(execution: TesterExecution): TesterArtifact {
  if (!execution.validation) {
    throw runtimeError("INVALID_CONTRACT", "Tester 执行结果缺少 ValidationReport，不能持久化。", {
      taskId: execution.result.taskId
    });
  }
  return {
    taskId: execution.result.taskId,
    status: execution.result.status,
    summary: execution.result.summary,
    validation: execution.validation,
    blockers: [...execution.result.blockers],
    createdAt: Date.now()
  };
}

function requireExecutionPlan(execution: TesterExecution) {
  if (!execution.state.plan) {
    throw runtimeError("INVALID_CONTRACT", "Tester 执行后缺少 Runtime Plan 状态。", {
      taskId: execution.result.taskId
    });
  }
  return execution.state.plan;
}

function defaultTestScope(readScope: string[]) {
  return readScope.filter((pattern) => /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(pattern));
}

/** 只接管已批准 Plan 中依赖已完成的下一个 test Task，并原子保存验证制品。 */
export async function executeApprovedTesterTask(
  session: TaskSession,
  options: {
    runtime?: TesterRuntimeFacade;
    changedFiles?: string[];
    testScope?: string[];
    acceptanceEvidence?: AcceptanceEvidenceInput[];
  } = {}
): Promise<ApprovedTesterExecutionResult> {
  if (session.agentMode !== "act") return { outcome: "not_applicable", reason: "任务不处于 act 模式。" };
  if (session.planApproval?.status !== "approved") return { outcome: "not_applicable", reason: "任务计划尚未批准。" };
  const plan = session.runtimePlan;
  if (!plan) return { outcome: "not_applicable", reason: "任务没有 Runtime Plan。" };

  const completedTaskIds = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  const task = plan.tasks.find((candidate) =>
    candidate.type === "test"
    && candidate.status === "pending"
    && candidate.dependencies.every((dependency) => completedTaskIds.has(dependency))
  );
  if (!task) return { outcome: "not_applicable", reason: "当前没有可执行的 test Task。" };

  const changedFiles = options.changedFiles?.length
    ? options.changedFiles
    : session.runtimeEvidence?.appliedFilePaths.length
      ? session.runtimeEvidence.appliedFilePaths
      : session.filesChanged;
  const testScope = options.testScope?.length ? options.testScope : defaultTestScope(task.readScope);
  if (!changedFiles.length) return { outcome: "not_applicable", reason: "当前任务没有可验证的改动文件。" };
  if (!testScope.length) return { outcome: "not_applicable", reason: "test Task 没有明确测试范围。" };

  const runtime = options.runtime ?? new MainAgentRuntime();
  const taskOptions: TesterTaskOptions = {
    changedFiles,
    testScope,
    acceptanceEvidence: options.acceptanceEvidence ?? [],
    context: { taskSessionId: session.id },
    constraints: ["只能运行受控验证命令，不能修改任何文件。"]
  };
  const execution = await runtime.executeTestTask(plan, task.id, taskOptions);
  const artifact = createArtifact(execution);
  const updated = await recordTaskSessionTesterExecution(session.id, requireExecutionPlan(execution), artifact);
  if (!updated) throw runtimeError("INVALID_CONTRACT", "Tester 执行结果未能写入任务会话。", { taskSessionId: session.id });
  return { outcome: "executed", execution, artifact, session: updated };
}
