import type { DeveloperArtifact } from "./agents/developer/contracts.js";
import type { DeveloperExecution } from "./agents/developer/developerAgentRuntime.js";
import { MainAgentRuntime } from "./agents/main/mainAgentRuntime.js";
import { runtimeError } from "./runtime/errors.js";
import { recordTaskSessionDeveloperExecution } from "./taskSessionStore.js";
import type { TaskSession } from "./types.js";

type DeveloperRuntimeFacade = Pick<MainAgentRuntime, "executeDeveloperTask" | "resolveDeveloperScopeChange">;

export type ApprovedDeveloperExecutionResult =
  | { outcome: "not_applicable"; reason: string }
  | {
      outcome: "executed";
      execution: DeveloperExecution;
      artifacts: DeveloperArtifact[];
      session: TaskSession;
    };

function createArtifact(execution: DeveloperExecution): DeveloperArtifact {
  return {
    taskId: execution.result.taskId,
    status: execution.result.status,
    summary: execution.result.summary,
    changedFiles: [...execution.result.changedFiles],
    evidence: [...execution.result.evidence],
    blockers: [...execution.result.blockers],
    checkpointIds: [...execution.checkpointIds],
    ...(execution.result.scopeChangeRequest
      ? {
          scopeChangeRequest: {
            reason: execution.result.scopeChangeRequest.reason,
            requiredScope: [...execution.result.scopeChangeRequest.requiredScope]
          }
        }
      : {}),
    createdAt: Date.now()
  };
}

function requireExecutionPlan(execution: DeveloperExecution) {
  if (!execution.state.plan) {
    throw runtimeError("INVALID_CONTRACT", "Developer 执行后缺少 Runtime Plan 状态。", {
      taskId: execution.result.taskId
    });
  }
  return execution.state.plan;
}

/** 只接管已批准 Plan 中的下一个 implement Task；其他请求继续使用现有生产链路。 */
export async function executeApprovedDeveloperTask(
  session: TaskSession,
  options: { runtime?: DeveloperRuntimeFacade } = {}
): Promise<ApprovedDeveloperExecutionResult> {
  if (session.agentMode !== "act") return { outcome: "not_applicable", reason: "任务不处于 act 模式。" };
  if (session.planApproval?.status !== "approved") {
    return { outcome: "not_applicable", reason: "任务计划尚未批准。" };
  }
  const plan = session.runtimePlan;
  if (!plan) return { outcome: "not_applicable", reason: "任务没有 Runtime Plan。" };

  const completedTaskIds = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  const task = plan.tasks.find((candidate) =>
    candidate.type === "implement"
    && candidate.status === "pending"
    && candidate.dependencies.every((dependency) => completedTaskIds.has(dependency))
  );
  if (!task) return { outcome: "not_applicable", reason: "当前没有可执行的 implement Task。" };

  const runtime = options.runtime ?? new MainAgentRuntime();
  const context = {
    taskSessionId: session.id,
    explorerArtifacts: session.explorerArtifacts ?? [],
    filesRead: session.filesRead
  };
  const constraints = ["只能修改已批准 Runtime Plan 授权的路径。"];
  const artifacts: DeveloperArtifact[] = [];
  let execution = await runtime.executeDeveloperTask(plan, task.id, { context, constraints });
  let executionPlan = requireExecutionPlan(execution);
  let artifact = createArtifact(execution);
  artifacts.push(artifact);

  if (execution.result.status === "blocked" && execution.result.scopeChangeRequest) {
    const authorizedScope = {
      readScope: [...new Set(plan.tasks.flatMap((item) => item.readScope))],
      writeScope: [...new Set(plan.tasks.flatMap((item) => item.writeScope))]
    };
    const decision = runtime.resolveDeveloperScopeChange(
      executionPlan,
      task.id,
      execution.result,
      authorizedScope
    );
    if (decision.action === "expand_task") {
      await recordTaskSessionDeveloperExecution(session.id, decision.plan, artifact);
      // 小范围扩展仍在用户总授权内，Main 更新 Task 后只允许自动重试一次。
      execution = await runtime.executeDeveloperTask(decision.plan, task.id, { context, constraints });
      executionPlan = requireExecutionPlan(execution);
      artifact = createArtifact(execution);
      artifacts.push(artifact);
    }
  }

  const updated = await recordTaskSessionDeveloperExecution(session.id, executionPlan, artifact);
  if (!updated) throw runtimeError("INVALID_CONTRACT", "Developer 执行结果未能写入任务会话。", { taskSessionId: session.id });
  return { outcome: "executed", execution, artifacts, session: updated };
}
