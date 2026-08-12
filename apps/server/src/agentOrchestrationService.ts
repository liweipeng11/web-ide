import type { DeveloperArtifact } from "./agents/developer/contracts.js";
import type { ExplorerArtifact } from "./agents/explorer/contracts.js";
import type { ExplorerExecution } from "./agents/explorer/explorerAgentRuntime.js";
import {
  MainAgentOrchestrator,
  type ExecuteOrchestrationPlanOptions,
  type MainOrchestrationResult,
  type OrchestrationExecution,
  type OrchestrationLifecycleEvent,
  type OrchestrationTrace
} from "./agents/main/index.js";
import { MainAgentRuntime, type MainAgentRequest, type MainAgentRuntimeResult } from "./agents/main/mainAgentRuntime.js";
import type { AcceptanceEvidenceInput, TesterArtifact } from "./agents/tester/contracts.js";
import type { RouteDecision, Task } from "./runtime/contracts.js";
import { runtimeError } from "./runtime/errors.js";
import { isPathInScope } from "./runtime/permissionManager.js";
import { planVerification } from "./verifier/index.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import {
  getTaskSession,
  recordTaskSessionOrchestrationResult,
  recordTaskSessionDeveloperExecution,
  recordTaskSessionTesterExecution,
  setTaskSessionRuntimePlanning
} from "./taskSessionStore.js";
import type { TaskSession } from "./types.js";

type OrchestratorFacade = Pick<MainAgentOrchestrator, "executePlan">;
type DirectMainRuntimeFacade = Pick<MainAgentRuntime, "plan" | "executeDecision">;

export type ApprovedAgentPipelineResult =
  | { outcome: "not_applicable"; reason: string }
  | {
      outcome: "executed";
      orchestration: MainOrchestrationResult;
      session: TaskSession;
    };

export type DirectMainExecutionResult =
  | { outcome: "not_applicable" }
  | { outcome: "executed"; execution: MainAgentRuntimeResult; summary: string };

/** Simple 生产请求只经过新 Main；非 direct 决策交还现有兼容链路。 */
export async function executeDirectMainRequest(
  session: TaskSession,
  request: MainAgentRequest,
  options: { runtime?: DirectMainRuntimeFacade } = {}
): Promise<DirectMainExecutionResult> {
  const runtime = options.runtime ?? new MainAgentRuntime();
  const planning = await runtime.plan(request);
  if (planning.decision.route !== "direct") return { outcome: "not_applicable" };
  const execution = await runtime.executeDecision(request, planning.decision);
  const summary = execution.outcome === "executed" ? execution.execution.result.summary : "Main 未能完成直接响应。";
  const status = execution.outcome === "executed" ? execution.execution.result.status : "blocked";
  await recordTaskSessionOrchestrationResult(session.id, {
    calledAgents: ["main"],
    events: [
      { agent: "main", action: "route" },
      { agent: "main", action: status === "success" ? "finish" : "stop", status }
    ]
  }, summary);
  return { outcome: "executed", execution, summary };
}

function routeDecisionForSession(session: TaskSession): RouteDecision {
  const usesPlanner = session.runtimePlan?.tasks.some((task) => task.type === "explore") ?? false;
  return {
    intent: "code_change",
    complexity: usesPlanner ? "complex" : "medium",
    route: usesPlanner ? "planned" : "main_loop",
    requiredCapabilities: usesPlanner
      ? ["planning", "exploration", "editing", "testing"]
      : ["read", "edit"]
  };
}

function orchestrationTraceForSession(session: TaskSession, decision: RouteDecision): OrchestrationTrace {
  const trace: OrchestrationTrace = {
    calledAgents: ["main"],
    events: [{ agent: "main", action: "route" }]
  };
  if (decision.route !== "planned") return trace;

  // 复杂任务的规划与执行跨越用户审批请求，需要从已持久化产物恢复前半段真实轨迹。
  trace.calledAgents.push("planner");
  trace.events.push({ agent: "planner", action: "plan", status: "ready" });
  for (const artifact of session.explorerArtifacts ?? []) {
    if (!trace.calledAgents.includes("explorer")) trace.calledAgents.push("explorer");
    trace.events.push({ agent: "explorer", action: "execute", taskId: artifact.taskId, status: "success" });
  }
  return trace;
}

function failureCountsForSession(session: TaskSession) {
  const counts: Record<string, number> = {};
  for (const artifact of [...(session.developerArtifacts ?? []), ...(session.testerArtifacts ?? [])]) {
    if (artifact.status === "failed") counts[artifact.taskId] = (counts[artifact.taskId] ?? 0) + 1;
    if (artifact.status === "success") delete counts[artifact.taskId];
  }
  return counts;
}

function developerArtifact(execution: Extract<OrchestrationExecution, { agent: "developer" }>["execution"]): DeveloperArtifact {
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

function testerArtifact(execution: Extract<OrchestrationExecution, { agent: "tester" }>["execution"]): TesterArtifact {
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

async function resolveTestContext(
  task: Task,
  changedFiles: string[]
) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) return { testScope: [], acceptanceEvidence: [] };
  const verificationPlan = await planVerification(workspaceRoot, null, { changedFiles });
  // 只有现有增量验证规划器确认的相关测试才能证明验收条件，不能用全仓测试冒充映射。
  const relatedTests = verificationPlan.relatedTests.filter((filePath) => task.readScope.some((scope) => {
    try {
      return isPathInScope(filePath, [scope]);
    } catch {
      return false;
    }
  }));
  return {
    testScope: relatedTests,
    acceptanceEvidence: relatedTests.length
      ? task.acceptanceCriteria.map((criterion) => ({ criterion, testFiles: [...relatedTests] }))
      : []
  };
}

async function persistExecution(taskSessionId: string, execution: OrchestrationExecution) {
  const plan = execution.execution.state.plan;
  if (!plan) {
    throw runtimeError("INVALID_CONTRACT", `${execution.agent} 执行后缺少 Runtime Plan。`, {
      taskId: execution.execution.result.taskId
    });
  }

  if (execution.agent === "developer") {
    await recordTaskSessionDeveloperExecution(taskSessionId, plan, developerArtifact(execution.execution));
    return;
  }
  if (execution.agent === "tester") {
    await recordTaskSessionTesterExecution(taskSessionId, plan, testerArtifact(execution.execution));
    return;
  }
  if (execution.execution.exploration) {
    const artifact: ExplorerArtifact = {
      taskId: execution.execution.result.taskId,
      result: execution.execution.exploration,
      createdAt: Date.now()
    };
    await setTaskSessionRuntimePlanning(taskSessionId, { status: "ready", plan }, [artifact]);
  }
}

async function persistReplanExplorations(taskSessionId: string, plan: import("./runtime/contracts.js").Plan, executions: ExplorerExecution[]) {
  const artifacts: ExplorerArtifact[] = executions.flatMap((execution) => execution.exploration
    ? [{ taskId: execution.result.taskId, result: execution.exploration, createdAt: Date.now() }]
    : []);
  await setTaskSessionRuntimePlanning(taskSessionId, { status: "ready", plan }, artifacts);
}

/** 在用户批准后连续推进 Runtime DAG，并在每个 Agent 返回后立即持久化可信进度。 */
export async function executeApprovedAgentPipeline(
  session: TaskSession,
  options: {
    orchestrator?: OrchestratorFacade;
    testScope?: string[];
    acceptanceEvidence?: AcceptanceEvidenceInput[];
    signal?: AbortSignal;
    /** 将新编排角色事件桥接到旧 Runtime 已使用的会话/SSE 生命周期。 */
    onLifecycleEvent?: (event: OrchestrationLifecycleEvent) => Promise<void> | void;
  } = {}
): Promise<ApprovedAgentPipelineResult> {
  if (session.agentMode !== "act") return { outcome: "not_applicable", reason: "任务不处于 act 模式。" };
  if (session.planApproval?.status !== "approved") {
    return { outcome: "not_applicable", reason: "任务计划尚未批准。" };
  }
  if (!session.runtimePlan) return { outcome: "not_applicable", reason: "任务没有 Runtime Plan。" };

  const orchestrator = options.orchestrator ?? new MainAgentOrchestrator();
  const decision = routeDecisionForSession(session);
  const executionOptions: ExecuteOrchestrationPlanOptions = {
    constraints: ["只能执行已批准 Runtime Plan 中的任务和授权范围。"],
    context: {
      taskSessionId: session.id,
      explorerArtifacts: session.explorerArtifacts ?? [],
      filesRead: session.filesRead
    },
    initialChangedFiles: session.runtimeEvidence?.appliedFilePaths.length
      ? session.runtimeEvidence.appliedFilePaths
      : session.filesChanged,
    initialFailureCounts: failureCountsForSession(session),
    authorizedScope: {
      readScope: [...new Set(session.runtimePlan.tasks.flatMap((task) => task.readScope))],
      writeScope: [...new Set(session.runtimePlan.tasks.flatMap((task) => task.writeScope))]
    },
    testScope: options.testScope,
    acceptanceEvidence: options.acceptanceEvidence,
    trace: orchestrationTraceForSession(session, decision),
    resolveTestContext,
    onExecution: (execution) => persistExecution(session.id, execution),
    onLifecycleEvent: options.onLifecycleEvent,
    // Planner 返回新版 DAG 或 Main 扩展当前任务后立即落盘，避免进程中断恢复到 blocked 旧计划。
    onPlanUpdate: async (plan) => {
      await setTaskSessionRuntimePlanning(session.id, { status: "ready", plan });
    },
    onReplanExplorations: (plan, explorations) => persistReplanExplorations(session.id, plan, explorations),
    signal: options.signal
  };
  const orchestration = await orchestrator.executePlan(
    decision,
    session.runtimePlan,
    executionOptions
  );
  await recordTaskSessionOrchestrationResult(session.id, orchestration.trace, orchestration.summary);
  const updated = await getTaskSession(session.id);
  return { outcome: "executed", orchestration, session: updated };
}
