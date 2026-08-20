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
import { EXPLORER_TOOL_NAMES, explorerRuntimeTools } from "./agents/explorer/explorerTools.js";
import type { AcceptanceEvidenceInput, TesterArtifact } from "./agents/tester/contracts.js";
import type { RouteDecision, Task } from "./runtime/contracts.js";
import { AgentRuntimeError, runtimeError } from "./runtime/errors.js";
import { isPathInScope } from "./runtime/permissionManager.js";
import { planVerification } from "./verifier/index.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import {
  getTaskSession,
  appendTaskSessionStep,
  recordTaskSessionOrchestrationResult,
  recordTaskSessionDeveloperExecution,
  recordTaskSessionTesterExecution,
  setTaskSessionRuntimePlanning
} from "./taskSessionStore.js";
import type { AgentStep, TaskSession } from "./types.js";
import { config } from "./config.js";
import { runApprovedPipelineGraph } from "./langgraph/approvedPipelineGraph.js";
import {
  createMainGraph,
  type MainGraphBranchResult
} from "./langgraph/main/mainGraph.js";
import {
  routeApprovedTaskSession,
  runApprovedTaskSessionMainGraph
} from "./langgraph/main/taskSessionMainGraph.js";
import type { ReadOnlyRuntimeMode, WriteRuntimeMode } from "./langgraph/rollout/featureFlags.js";
import {
  executeReadOnlyRuntimeRollout,
  type ReadOnlyRuntimeObservation
} from "./langgraph/rollout/runtimeSelector.js";
import { appendShadowComparisonMetric, type ShadowComparisonMetric } from "./langgraph/rollout/shadowComparison.js";
import {
  defaultWriteRuntimeGate,
  selectWriteRuntime,
  snapshotTaskSideEffects,
  type WriteRuntimeGate,
  type WriteRuntimeSafetyReason
} from "./langgraph/rollout/writeRuntimeGate.js";
import { withRuntimeObservationContext } from "./langgraph/rollout/runtimeObservationContext.js";

type OrchestratorFacade = Pick<MainAgentOrchestrator, "executePlan">;
type DirectMainRuntimeFacade = Pick<MainAgentRuntime, "plan" | "executeDecision">;

export type DirectMainReadOnlyRollout = {
  mode?: ReadOnlyRuntimeMode;
  internalTask?: boolean;
  execute?: (request: MainAgentRequest, decision: RouteDecision) => Promise<MainAgentRuntimeResult>;
  observe?: (observation: ReadOnlyRuntimeObservation) => Promise<void> | void;
};

type DirectMainPathResult =
  | { outcome: "not_applicable"; decision: RouteDecision }
  | { outcome: "executed"; decision: RouteDecision; execution: MainAgentRuntimeResult };

export type ApprovedAgentPipelineResult =
  | { outcome: "not_applicable"; reason: string }
  | {
      outcome: "executed";
      orchestration: MainOrchestrationResult;
      session: TaskSession;
    };

export type ApprovedPipelineWriteRollout = {
  mode?: WriteRuntimeMode;
  internalTask?: boolean;
  gate?: WriteRuntimeGate;
};

export type DirectMainExecutionResult =
  | { outcome: "not_applicable" }
  | { outcome: "executed"; execution: MainAgentRuntimeResult; summary: string };

/** 只读 direct/main_loop 请求由统一 Main Graph 路由和执行；写任务仍交给批准流水线。 */
export async function executeDirectMainRequest(
  session: TaskSession,
  request: MainAgentRequest,
  options: { runtime?: DirectMainRuntimeFacade; readOnlyRollout?: DirectMainReadOnlyRollout } = {}
): Promise<DirectMainExecutionResult> {
  const runtime = options.runtime ?? new MainAgentRuntime({
    tools: explorerRuntimeTools,
    allowedTools: [...EXPLORER_TOOL_NAMES]
  });
  // 服务入口统一绑定 TaskSession，避免百分比灰度因重试或刷新切换执行路径。
  const stableRequest: MainAgentRequest = {
    ...request,
    readScope: request.readScope?.length ? request.readScope : ["**"],
    rolloutKey: request.rolloutKey ?? session.id
  };
  const rollout = options.readOnlyRollout;
  const rolloutMode = rollout?.mode ?? config.readOnlyRuntimeRollout.mode;
  const pathResult = await executeReadOnlyRuntimeRollout({
    mode: rolloutMode,
    internalTask: rollout?.internalTask,
    taskKey: stableRequest.rolloutKey,
    legacy: () => withRuntimeObservationContext(
      { controlPlane: "legacy", rolloutMode },
      () => executeReadOnlyMainLegacy(stableRequest, runtime)
    ),
    // 生产默认始终提供 Main Graph；all 模式不会再因调用方没有注入 executor 而回到 Legacy。
    next: () => withRuntimeObservationContext(
      { controlPlane: "langgraph", rolloutMode },
      () => executeReadOnlyMainGraph(stableRequest, runtime, rollout?.execute)
    ),
    describe: describeDirectPathResult,
    observe: rollout?.observe ?? (async (observation) => {
      // 生产观测只持久化 shadow 固定枚举、差异维度和耗时区间。
      if (observation.mode === "shadow" && observation.legacyStatus !== "not_run" && observation.nextStatus !== "not_run") {
        const metric: ShadowComparisonMetric = {
          schemaVersion: 1,
          recordedAt: new Date().toISOString(),
          mode: "shadow",
          selected: "legacy",
          legacyStatus: observation.legacyStatus,
          nextStatus: observation.nextStatus,
          legacyDuration: observation.legacyDuration ?? "gte_10s",
          nextDuration: observation.nextDuration ?? "gte_10s",
          ...(observation.comparison ? { comparison: observation.comparison } : {})
        };
        await appendShadowComparisonMetric(metric);
      }
    })
  });
  if (pathResult.outcome === "not_applicable") return { outcome: "not_applicable" };
  const execution = pathResult.execution;
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

async function executeReadOnlyMainLegacy(
  request: MainAgentRequest,
  runtime: DirectMainRuntimeFacade
): Promise<DirectMainPathResult> {
  const planning = await runtime.plan(request);
  if (!isReadOnlyMainDecision(planning.decision)) {
    return { outcome: "not_applicable", decision: planning.decision };
  }
  return {
    outcome: "executed",
    decision: planning.decision,
    execution: await runtime.executeDecision(request, planning.decision)
  };
}

async function executeReadOnlyMainGraph(
  request: MainAgentRequest,
  runtime: DirectMainRuntimeFacade,
  executeOverride?: DirectMainReadOnlyRollout["execute"]
): Promise<DirectMainPathResult> {
  let execution: MainAgentRuntimeResult | undefined;
  let executionError: unknown;
  const runBranch = async (branchRequest: MainAgentRequest, decision: RouteDecision): Promise<MainGraphBranchResult> => {
    if (!isReadOnlyMainDecision(decision)) {
      return { outcome: "blocked", summary: "该请求需要进入已授权的写任务流水线。" };
    }
    try {
      execution = executeOverride
        ? await executeOverride(branchRequest, decision)
        : await runtime.executeDecision(branchRequest, decision);
      return describeMainGraphExecution(execution);
    } catch (error) {
      executionError = error;
      throw error;
    }
  };
  const mainGraph = createMainGraph({
    route: async (graphRequest) => (await runtime.plan(graphRequest)).decision,
    runDirect: runBranch,
    runMainLoop: runBranch,
    async runPlanning() {
      return { status: "blocked", summary: "复杂任务需要先完成计划和审批。" };
    },
    async runPlanned() {
      throw runtimeError("INVALID_CONTRACT", "只读 Main Graph 不应直接执行 planned 分支。");
    }
  });
  const graph = await mainGraph.invoke(request);
  if (executionError) throw executionError;
  if (!graph.decision) {
    throw runtimeError("INVALID_CONTRACT", "Main Graph 未返回路由决策。", { blockers: graph.blockers });
  }
  if (!isReadOnlyMainDecision(graph.decision)) {
    return { outcome: "not_applicable", decision: graph.decision };
  }
  if (!execution) {
    throw runtimeError("INVALID_CONTRACT", "Main Graph 未执行只读分支。", {
      route: graph.decision.route,
      outcome: graph.outcome,
      blockers: graph.blockers
    });
  }
  return { outcome: "executed", decision: graph.decision, execution };
}

function isReadOnlyMainDecision(decision: RouteDecision) {
  return decision.intent !== "code_change" && decision.route !== "planned";
}

function describeMainGraphExecution(execution: MainAgentRuntimeResult): MainGraphBranchResult {
  if (execution.outcome !== "executed") {
    return { outcome: "blocked", summary: "Main 返回了待处理的规划结果。" };
  }
  const result = execution.execution.result;
  return {
    outcome: result.status === "success" ? "completed" : result.status === "failed" ? "failed" : "blocked",
    summary: result.summary,
    facts: result.facts,
    changedFiles: result.changedFiles,
    blockers: result.blockers
  };
}

function describeDirectPathResult(result: DirectMainPathResult) {
  if (result.outcome === "not_applicable") {
    return { outcome: result.outcome, route: result.decision.route, result_status: "not_applicable" };
  }
  return describeDirectExecution(result.execution);
}

function describeDirectExecution(execution: MainAgentRuntimeResult) {
  return {
    outcome: execution.outcome,
    route: execution.decision.route,
    result_status: execution.outcome === "executed" ? execution.execution.result.status : execution.planning.status
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
async function executeApprovedAgentPipelineCore(
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
  const decision = routeApprovedTaskSession(session);
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

/**
 * 显式开启 Flag 后，批准任务由 Main Graph 控制流程入口；默认关闭时继续使用原有编排路径。
 * Graph 不持有业务状态，也不直接执行工具，因此不会改变审批、写入或恢复语义。
 */
export async function executeApprovedAgentPipeline(
  session: TaskSession,
  options: {
    orchestrator?: OrchestratorFacade;
    testScope?: string[];
    acceptanceEvidence?: AcceptanceEvidenceInput[];
    signal?: AbortSignal;
    onLifecycleEvent?: (event: OrchestrationLifecycleEvent) => Promise<void> | void;
    /** Graph 步骤已经由服务持久化；该回调只用于 SSE 等实时传输。 */
    onGraphStep?: (step: AgentStep) => Promise<void> | void;
    /** 仅用于受控写任务灰度；不能扩大 TaskSession 已批准的权限或作用域。 */
    writeRollout?: ApprovedPipelineWriteRollout;
  } = {}
): Promise<ApprovedAgentPipelineResult> {
  const gate = options.writeRollout?.gate ?? defaultWriteRuntimeGate;
  const rolloutMode = options.writeRollout?.mode ?? config.writeRuntimeRollout.mode;
  const selectedRuntime = selectWriteRuntime({
    enabled: config.featureFlags.langGraphRuntime,
    mode: rolloutMode,
    taskKey: session.id,
    internalTask: options.writeRollout?.internalTask,
    gateOpen: gate.isOpen()
  });
  if (selectedRuntime === "legacy") {
    return withRuntimeObservationContext(
      { controlPlane: "legacy", rolloutMode },
      () => executeApprovedAgentPipelineCore(session, options)
    );
  }

  const before = snapshotTaskSideEffects(session);
  try {
    const result = await withRuntimeObservationContext(
      { controlPlane: "langgraph", rolloutMode },
      () => runApprovedPipelineGraph(session, async (approvedSession) => {
      const execution = await runApprovedTaskSessionMainGraph({
        session: approvedSession,
        signal: options.signal,
        async onGraphStep(step) {
          await appendTaskSessionStep(approvedSession.id, step);
          await options.onGraphStep?.(step);
        },
        onGraphEventError(error) {
          // 事件观测失败不能触发业务流水线重跑，也不能输出用户内容或源码。
          console.warn("[langgraph-event] AgentStep 持久化或推送失败", error instanceof Error ? error.name : "unknown");
        },
        // Graph 负责唯一控制流；Core 仅执行当前 Graph 节点委托的业务 DAG 和副作用。
        execute: () => executeApprovedAgentPipelineCore(approvedSession, options),
        describe(value) {
          if (value.outcome !== "executed") {
            throw runtimeError("INVALID_CONTRACT", "已批准流水线没有返回执行结果。");
          }
          const { orchestration } = value;
          const existingFiles = new Set([...before.filesChanged, ...before.appliedFilePaths]);
          const newlyReportedFiles = orchestration.changedFiles.filter((filePath) => !existingFiles.has(filePath));
          const scopeViolation = findWriteScopeViolation(approvedSession, newlyReportedFiles);
          if (scopeViolation) {
            gate.trip("scope_violation");
            throw runtimeError("SCOPE_VIOLATION", "LangGraph 写任务返回了批准范围外的文件。", { filePath: scopeViolation });
          }
          return {
            outcome: orchestration.status === "completed"
              ? "completed"
              : orchestration.status === "cancelled"
                ? "cancelled"
                : orchestration.status,
            summary: orchestration.summary,
            changedFiles: orchestration.changedFiles,
            blockers: orchestration.status === "completed" ? [] : [orchestration.summary]
          };
        }
      });
      return execution.value;
      })
    );
    if (result.outcome === "not_applicable") return result;
    return result.value;
  } catch (error) {
    gate.trip(writeRuntimeFailureReason(error));
    // 本次请求一旦选择 Graph，失败必须原样暴露；禁止按模式或副作用状态整体重跑 Legacy。
    throw error;
  }
}

function findWriteScopeViolation(session: TaskSession, changedFiles: string[]) {
  const writeScope = [...new Set(session.runtimePlan?.tasks.flatMap((task) => task.writeScope) ?? [])];
  return changedFiles.find((filePath) => !isPathInScope(filePath, writeScope));
}

function writeRuntimeFailureReason(error: unknown): WriteRuntimeSafetyReason {
  if (error instanceof AgentRuntimeError) {
    if (error.code === "SCOPE_VIOLATION" || error.code === "PERMISSION_DENIED") return "scope_violation";
    if (error.code === "INVALID_CONTRACT" || error.code === "INVALID_STATE_TRANSITION") return "state_corruption";
  }
  return "runtime_failure";
}
