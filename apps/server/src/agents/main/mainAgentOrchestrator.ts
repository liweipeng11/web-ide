import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import type { DeveloperTaskOptions } from "../developer/developerAgentRuntime.js";
import type { TesterTaskOptions } from "../tester/testerAgentRuntime.js";
import type { AgentResult, Plan, RouteDecision } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { validatePlan } from "../../runtime/stateManager.js";
import type {
  MainAgentExplorationPlanningResult,
  MainAgentReplanExecution,
  MainAgentReplanRequest,
  MainAgentRuntimeResult
} from "./mainAgentRuntime.js";
import type { MainSummaryInput } from "./mainAgent.js";
import type { MainReplanDecision, ReplanPolicyInput } from "./replanPolicy.js";
import { DEFAULT_MAX_REPLANS } from "./replanPolicy.js";
import { handleOrchestrationReplan } from "./orchestrationReplan.js";
import { MainAgentRuntime } from "./mainAgentRuntime.js";
import type {
  ExecuteOrchestrationPlanOptions,
  MainOrchestrationRequest,
  MainOrchestrationResult,
  OrchestrationExecution,
  OrchestrationTrace,
  OrchestrationTraceEvent,
  PreparedOrchestration
} from "./orchestrationContracts.js";
import {
  acceptanceEvidenceForTask,
  applyMainRespondTask,
  concreteTestFiles,
  createMainLoopPlan,
  DEFAULT_TEST_SCOPE,
  findRunnableTask,
  findRunnableTasks,
  uniqueStrings
} from "./orchestrationPlan.js";
import { config } from "../../config.js";

const DEFAULT_MAX_ORCHESTRATION_STEPS = 30;

export interface MainOrchestrationRuntimeFacade {
  executeDecision(request: MainOrchestrationRequest, decision: RouteDecision): Promise<MainAgentRuntimeResult>;
  planWithExploration(request: MainOrchestrationRequest): Promise<MainAgentExplorationPlanningResult>;
  executeExploreTask(plan: Plan, taskId: string, context?: unknown, options?: { signal?: AbortSignal }): Promise<ExplorerExecution>;
  executeDeveloperTask(plan: Plan, taskId: string, options?: DeveloperTaskOptions): ReturnType<MainAgentRuntime["executeDeveloperTask"]>;
  executeTestTask(plan: Plan, taskId: string, options: TesterTaskOptions): ReturnType<MainAgentRuntime["executeTestTask"]>;
  summarize(input: MainSummaryInput): Promise<string>;
  shouldReplan(input: ReplanPolicyInput): Promise<MainReplanDecision>;
  replanWithExploration(request: MainAgentReplanRequest): Promise<MainAgentReplanExecution>;
  resolveDeveloperScopeChange(
    plan: Plan,
    taskId: string,
    result: AgentResult,
    authorizedScope: { readScope: string[]; writeScope: string[] }
  ): ReturnType<MainAgentRuntime["resolveDeveloperScopeChange"]>;
}

function createTrace(): OrchestrationTrace {
  const startedAt = Date.now();
  return {
    traceId: `orchestration-${startedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    calledAgents: [],
    events: []
  };
}

function recordTrace(trace: OrchestrationTrace, event: OrchestrationTraceEvent) {
  if (!trace.calledAgents.includes(event.agent)) trace.calledAgents.push(event.agent);
  trace.events.push({ startedAt: Date.now(), ...event });
}

function cloneTrace(trace?: OrchestrationTrace): OrchestrationTrace {
  return trace
    ? { ...trace, calledAgents: [...trace.calledAgents], events: trace.events.map((event) => ({ ...event })) }
    : createTrace();
}

/** 阶段 6 的统一控制器：Main 负责路由和 DAG 推进，各专业 Agent 仍由独立 Runtime 执行。 */
export class MainAgentOrchestrator {
  constructor(
    private readonly runtime: MainOrchestrationRuntimeFacade = new MainAgentRuntime(),
    private readonly maxSteps = config.agentRuntimeStabilityPolicy.maxOrchestrationSteps ?? DEFAULT_MAX_ORCHESTRATION_STEPS,
    private readonly maxReplans = config.agentRuntimeStabilityPolicy.maxReplans ?? DEFAULT_MAX_REPLANS,
    private readonly maxConcurrency = config.agentRuntimeStabilityPolicy.maxConcurrency
  ) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw runtimeError("INVALID_CONTRACT", "编排最大步数必须是正整数。", { maxSteps });
    }
    if (!Number.isInteger(maxReplans) || maxReplans < 1) {
      throw runtimeError("INVALID_CONTRACT", "最大重规划次数必须是正整数。", { maxReplans });
    }
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw runtimeError("INVALID_CONTRACT", "最大并发数必须是正整数。", { maxConcurrency });
    }
  }

  async prepare(request: MainOrchestrationRequest): Promise<PreparedOrchestration> {
    const trace = createTrace();
    recordTrace(trace, { agent: "main", action: "route" });
    const planning = await this.runtime.planWithExploration(request);
    const { decision } = planning;

    if (decision.route === "direct") return { status: "direct", decision, trace };
    if (decision.route === "main_loop") {
      const plan = createMainLoopPlan(request);
      validatePlan(plan);
      return { status: "ready", decision, plan, explorations: [], trace };
    }

    recordTrace(trace, {
      agent: "planner",
      action: "plan",
      status: planning.planning?.status === "ready"
        ? "ready"
        : planning.planning?.status === "failed" ? "failed" : "missing_context"
    });
    for (const exploration of planning.explorations) {
      recordTrace(trace, {
        agent: "explorer",
        action: "execute",
        taskId: exploration.result.taskId,
        status: exploration.result.status
      });
    }
    for (const replan of planning.replans ?? []) {
      recordTrace(trace, {
        agent: "planner",
        action: "replan",
        taskId: replan.taskId,
        status: replan.status === "ready" ? "ready" : replan.status === "missing_context" ? "missing_context" : "failed",
        reason: replan.reason
      });
    }
    if (planning.planning?.status !== "ready") {
      const reason = planning.planning?.status === "failed"
        ? planning.planning.blockers.join("；")
        : planning.planning?.status === "missing_context"
          ? `Planner 需要补充上下文：${planning.planning.required.join("；")}`
          : "复杂任务没有得到可执行计划。";
      recordTrace(trace, { agent: "main", action: "stop" });
      return { status: "blocked", decision, reason, trace };
    }
    return {
      status: "ready",
      decision,
      plan: planning.planning.plan,
      explorations: planning.explorations,
      trace
    };
  }

  async run(request: MainOrchestrationRequest): Promise<MainOrchestrationResult> {
    const prepared = await this.prepare(request);
    if (prepared.status === "blocked") {
      prepared.trace.finishedAt = Date.now();
      return {
        status: "blocked",
        decision: prepared.decision,
        summary: prepared.reason,
        changedFiles: [],
        results: [],
        executions: [],
        trace: prepared.trace
      };
    }
    if (prepared.status === "direct") {
      const execution = await this.runtime.executeDecision(request, prepared.decision);
      const successful = execution.outcome === "executed" && execution.execution.result.status === "success";
      recordTrace(prepared.trace, { agent: "main", action: successful ? "finish" : "stop" });
      prepared.trace.finishedAt = Date.now();
      return {
        status: successful ? "completed" : "blocked",
        decision: prepared.decision,
        summary: execution.outcome === "executed"
          ? execution.execution.result.summary
          : "Direct 请求没有得到可执行结果。",
        changedFiles: execution.outcome === "executed" ? execution.execution.result.changedFiles : [],
        results: execution.outcome === "executed" ? [execution.execution.result] : [],
        executions: [],
        directExecution: execution,
        trace: prepared.trace
      };
    }
    return this.executePlan(prepared.decision, prepared.plan, {
      constraints: request.constraints,
      testScope: request.testScope,
      acceptanceEvidence: request.acceptanceEvidence,
      authorizedScope: {
        readScope: uniqueStrings(request.readScope ?? []),
        writeScope: uniqueStrings(request.writeScope ?? [])
      },
      trace: prepared.trace
    });
  }

  async executePlan(
    decision: RouteDecision,
    initialPlan: Plan,
    options: ExecuteOrchestrationPlanOptions = {}
  ): Promise<MainOrchestrationResult> {
    validatePlan(initialPlan);
    const executionConcurrency = options.maxConcurrency ?? this.maxConcurrency;
    if (!Number.isInteger(executionConcurrency) || executionConcurrency < 1) {
      throw runtimeError("INVALID_CONTRACT", "本次编排最大并发数必须是正整数。", { maxConcurrency: executionConcurrency });
    }
    let plan = initialPlan;
    const trace = cloneTrace(options.trace);
    if (!trace.calledAgents.includes("main")) recordTrace(trace, { agent: "main", action: "route" });
    const results: AgentResult[] = [];
    const executions: OrchestrationExecution[] = [];
    const changedFiles = uniqueStrings(options.initialChangedFiles ?? []);
    const failureCounts = new Map(
      Object.entries(options.initialFailureCounts ?? {})
        .filter(([, count]) => Number.isInteger(count) && count > 0)
    );
    let replanCount = 0;
    const authorizedScope = options.authorizedScope ?? {
      readScope: uniqueStrings(initialPlan.tasks.flatMap((task) => task.readScope)),
      writeScope: uniqueStrings(initialPlan.tasks.flatMap((task) => task.writeScope))
    };

    for (let step = 0; step < this.maxSteps; step += 1) {
      if (options.signal?.aborted) {
        recordTrace(trace, { agent: "main", action: "stop", status: "failed", reason: "用户已取消 Agent 编排。", failureCategory: "cancelled" });
        trace.finishedAt = Date.now();
        return {
          status: "cancelled",
          decision,
          plan,
          summary: "Agent 编排已取消。",
          changedFiles,
          results,
          executions,
          trace
        };
      }
      if (plan.tasks.every((task) => task.status === "completed")) {
        const summary = await this.runtime.summarize({
          goal: plan.goal,
          routeDecision: decision,
          results,
          changedFiles
        });
        recordTrace(trace, { agent: "main", action: "finish" });
        trace.finishedAt = Date.now();
        return {
          status: "completed",
          decision,
          plan,
          summary,
          changedFiles,
          results,
          executions,
          trace
        };
      }

      const task = findRunnableTask(plan);
      if (!task) {
        const terminal = plan.tasks.find((item) => item.status === "failed" || item.status === "blocked");
        recordTrace(trace, { agent: "main", action: "stop", taskId: terminal?.id });
        trace.finishedAt = Date.now();
        return {
          status: terminal?.status === "failed" ? "failed" : "blocked",
          decision,
          plan,
          summary: terminal ? `任务 ${terminal.id} ${terminal.status}，编排已安全停止。` : "计划中没有可运行任务。",
          changedFiles,
          results,
          executions,
          trace
        };
      }

      const runnableExplorers = findRunnableTasks(plan).filter((item) => item.type === "explore");
      const availableSlots = Math.max(1, this.maxSteps - step);
      const explorerBatch = runnableExplorers.slice(0, Math.min(executionConcurrency, availableSlots));
      if (explorerBatch.length > 1) {
        const concurrencyGroup = `explore-${plan.version}-${step + 1}`;
        const batchExecutions = await Promise.all(explorerBatch.map(async (batchTask): Promise<OrchestrationExecution> => {
          await options.onLifecycleEvent?.({ agent: "explorer", phase: "started", taskId: batchTask.id });
          return {
            agent: "explorer",
            execution: await this.runtime.executeExploreTask(plan, batchTask.id, options.context ?? {}, { signal: options.signal })
          };
        }));
        step += batchExecutions.length - 1;

        // 各 Explorer 基于同一 Plan 快照运行，结果必须合并回唯一 Plan，不能采用最后返回者覆盖前者。
        const batchStatuses = new Map(batchExecutions.map(({ execution }) => [
          execution.result.taskId,
          execution.result.status === "success" ? "completed" as const : execution.result.status
        ]));
        plan = {
          ...plan,
          tasks: plan.tasks.map((item) => batchStatuses.has(item.id)
            ? { ...item, status: batchStatuses.get(item.id)! }
            : item)
        };
        for (const batchExecution of batchExecutions) {
          const batchResult = batchExecution.execution.result;
          // 持久化回调接收合并后的统一 Plan，进程中断也不会恢复到同批次的局部快照。
          batchExecution.execution.state.plan = plan;
          executions.push(batchExecution);
          results.push(batchResult);
          changedFiles.splice(0, changedFiles.length, ...uniqueStrings([...changedFiles, ...batchResult.changedFiles]));
          await options.onExecution?.(batchExecution);
          await options.onLifecycleEvent?.({
            agent: "explorer",
            phase: "completed",
            taskId: batchResult.taskId,
            status: batchResult.status,
            summary: batchResult.summary
          });
          const diagnostics = batchExecution.execution.diagnostics;
          recordTrace(trace, {
            agent: "explorer",
            action: "execute",
            taskId: batchResult.taskId,
            status: batchResult.status,
            concurrencyGroup,
            ...(diagnostics
              ? {
                  startedAt: diagnostics.startedAt,
                  finishedAt: diagnostics.finishedAt,
                  durationMs: diagnostics.durationMs,
                  attempt: diagnostics.attempts,
                  retries: diagnostics.retries,
                  timeoutMs: diagnostics.timeoutMs,
                  retryable: diagnostics.retryable,
                  failureCategory: diagnostics.failureCategory
                }
              : {})
          });
        }
        await options.onPlanUpdate?.(plan, "concurrency_merge");

        const cancelled = batchExecutions.find((item) => item.execution.diagnostics?.failureCategory === "cancelled");
        if (cancelled) {
          recordTrace(trace, { agent: "main", action: "stop", taskId: cancelled.execution.result.taskId, reason: "用户已取消 Agent 编排。", failureCategory: "cancelled" });
          trace.finishedAt = Date.now();
          return { status: "cancelled", decision, plan, summary: "Agent 编排已取消。", changedFiles, results, executions, trace };
        }

        const failedExecution = batchExecutions.find((item) => item.execution.result.status !== "success");
        if (!failedExecution) continue;
        const failedResult = failedExecution.execution.result;
        const transition = await handleOrchestrationReplan({
          runtime: this.runtime,
          agent: "explorer",
          plan,
          result: failedResult,
          results,
          failureCounts,
          authorizedScope,
          constraints: options.constraints,
          replanCount,
          maxReplans: this.maxReplans,
          runtimeDiagnostics: failedExecution.execution.diagnostics,
          signal: options.signal
        });
        replanCount = transition.replanCount;
        plan = transition.plan;
        if (transition.traceEvent) recordTrace(trace, transition.traceEvent);
        if (transition.planUpdate) {
          validatePlan(plan);
          await options.onPlanUpdate?.(plan, transition.planUpdate);
        }
        if (transition.action === "stop") {
          const status = transition.status ?? "blocked";
          const summary = transition.summary ?? failedResult.summary;
          recordTrace(trace, { agent: "main", action: "stop", taskId: failedResult.taskId, status, reason: summary });
          trace.finishedAt = Date.now();
          return { status, decision, plan, summary, changedFiles, results, executions, trace };
        }
        continue;
      }

      let execution: OrchestrationExecution | null = null;
      if (task.type === "explore") {
        await options.onLifecycleEvent?.({ agent: "explorer", phase: "started", taskId: task.id });
        const explored = await this.runtime.executeExploreTask(plan, task.id, options.context ?? {}, { signal: options.signal });
        execution = { agent: "explorer", execution: explored };
      } else if (task.type === "implement") {
        await options.onLifecycleEvent?.({ agent: "developer", phase: "started", taskId: task.id });
        const developed = await this.runtime.executeDeveloperTask(plan, task.id, {
          context: options.context,
          constraints: options.constraints,
          signal: options.signal
        });
        execution = { agent: "developer", execution: developed };
      } else if (task.type === "test") {
        if (!changedFiles.length) {
          recordTrace(trace, { agent: "main", action: "stop", taskId: task.id });
          trace.finishedAt = Date.now();
          return {
            status: "blocked",
            decision,
            plan,
            summary: "Tester 启动前没有 Runtime 确认的 changedFiles。",
            changedFiles,
            results,
            executions,
            trace
          };
        }
        await options.onLifecycleEvent?.({ agent: "tester", phase: "started", taskId: task.id });
        // 生产入口可在 Developer 真实落盘后，基于 changedFiles 动态解析相关测试与验收映射。
        const resolvedTestContext = await options.resolveTestContext?.(task, [...changedFiles]);
        const testScope = uniqueStrings(resolvedTestContext?.testScope.length
          ? resolvedTestContext.testScope
          : options.testScope?.length ? options.testScope : [
              ...concreteTestFiles(task),
              ...DEFAULT_TEST_SCOPE
            ]);
        const tested = await this.runtime.executeTestTask(plan, task.id, {
          context: options.context,
          constraints: options.constraints,
          changedFiles,
          testScope,
          acceptanceEvidence: resolvedTestContext?.acceptanceEvidence.length
            ? resolvedTestContext.acceptanceEvidence
            : acceptanceEvidenceForTask(task, options.acceptanceEvidence),
          signal: options.signal
        });
        execution = { agent: "tester", execution: tested };
      } else {
        await options.onLifecycleEvent?.({ agent: "main", phase: "started", taskId: task.id });
        const responded = applyMainRespondTask(plan, task);
        plan = responded.plan;
        results.push(responded.result);
        await options.onLifecycleEvent?.({
          agent: "main",
          phase: "completed",
          taskId: task.id,
          status: responded.result.status,
          summary: responded.result.summary
        });
        recordTrace(trace, { agent: "main", action: "execute", taskId: task.id, status: "success" });
        continue;
      }

      const rawResult = execution.execution.result;
      const result: AgentResult = {
        ...rawResult,
        // Runtime 工具可能在 Agent 最终失败前已经完成受控写入，重试决策必须消费可信 State 进度。
        changedFiles: uniqueStrings([...rawResult.changedFiles, ...execution.execution.state.changedFiles])
      };
      execution.execution.result = result;
      executions.push(execution);
      await options.onExecution?.(execution);
      results.push(result);
      await options.onLifecycleEvent?.({
        agent: execution.agent,
        phase: "completed",
        taskId: result.taskId,
        status: result.status,
        summary: result.summary
      });
      changedFiles.splice(0, changedFiles.length, ...uniqueStrings([...changedFiles, ...result.changedFiles]));
      const nextPlan = execution.execution.state.plan;
      if (!nextPlan) throw runtimeError("INVALID_CONTRACT", `${execution.agent} 执行后缺少 Runtime Plan。`);
      plan = nextPlan;
      recordTrace(trace, {
        agent: execution.agent,
        action: "execute",
        taskId: result.taskId,
        status: result.status,
        ...(execution.execution.diagnostics
          ? {
              startedAt: execution.execution.diagnostics.startedAt,
              finishedAt: execution.execution.diagnostics.finishedAt,
              durationMs: execution.execution.diagnostics.durationMs,
              attempt: execution.execution.diagnostics.attempts,
              retries: execution.execution.diagnostics.retries,
              timeoutMs: execution.execution.diagnostics.timeoutMs,
              retryable: execution.execution.diagnostics.retryable,
              failureCategory: execution.execution.diagnostics.failureCategory
            }
          : {})
      });

      if (execution.execution.diagnostics?.failureCategory === "cancelled") {
        recordTrace(trace, { agent: "main", action: "stop", taskId: result.taskId, reason: "用户已取消 Agent 编排。", failureCategory: "cancelled" });
        trace.finishedAt = Date.now();
        return { status: "cancelled", decision, plan, summary: "Agent 编排已取消。", changedFiles, results, executions, trace };
      }

      const transition = await handleOrchestrationReplan({
        runtime: this.runtime,
        agent: execution.agent,
        plan,
        result,
        results,
        failureCounts,
        authorizedScope,
        constraints: options.constraints,
        replanCount,
        maxReplans: this.maxReplans,
        runtimeDiagnostics: execution.execution.diagnostics,
        signal: options.signal
      });
      if (result.status === "success") failureCounts.delete(result.taskId);
      replanCount = transition.replanCount;
      plan = transition.plan;
      for (const exploration of transition.explorations ?? []) {
        const auxiliary: OrchestrationExecution = { agent: "explorer", execution: exploration };
        executions.push(auxiliary);
        results.push(exploration.result);
        recordTrace(trace, {
          agent: "explorer",
          action: "execute",
          taskId: exploration.result.taskId,
          status: exploration.result.status
        });
      }
      if (transition.traceEvent) recordTrace(trace, transition.traceEvent);
      if (transition.planUpdate) {
        validatePlan(plan);
        await options.onPlanUpdate?.(plan, transition.planUpdate);
      }
      if (transition.explorations?.length) {
        await options.onReplanExplorations?.(plan, transition.explorations);
      }
      if (transition.action === "stop") {
        const status = transition.status ?? "blocked";
        const summary = transition.summary ?? result.summary;
        recordTrace(trace, { agent: "main", action: "stop", taskId: result.taskId, status, reason: summary });
        trace.finishedAt = Date.now();
        return {
          status,
          decision,
          plan,
          summary,
          changedFiles,
          results,
          executions,
          trace
        };
      }
      if (transition.planUpdate) continue;
    }

    throw runtimeError("AGENT_LOOP_LIMIT_EXCEEDED", `编排循环超过最大步数 ${this.maxSteps}。`, {
      maxSteps: this.maxSteps
    });
  }
}
