import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import type { DeveloperTaskOptions } from "../developer/developerAgentRuntime.js";
import type { TesterTaskOptions } from "../tester/testerAgentRuntime.js";
import type { AgentResult, Plan, RouteDecision } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { validatePlan } from "../../runtime/stateManager.js";
import type { MainAgentExplorationPlanningResult, MainAgentRuntimeResult } from "./mainAgentRuntime.js";
import type { MainSummaryInput } from "./mainAgent.js";
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
  uniqueStrings
} from "./orchestrationPlan.js";

const DEFAULT_MAX_ORCHESTRATION_STEPS = 30;

export interface MainOrchestrationRuntimeFacade {
  executeDecision(request: MainOrchestrationRequest, decision: RouteDecision): Promise<MainAgentRuntimeResult>;
  planWithExploration(request: MainOrchestrationRequest): Promise<MainAgentExplorationPlanningResult>;
  executeExploreTask(plan: Plan, taskId: string, context?: unknown): Promise<ExplorerExecution>;
  executeDeveloperTask(plan: Plan, taskId: string, options?: DeveloperTaskOptions): ReturnType<MainAgentRuntime["executeDeveloperTask"]>;
  executeTestTask(plan: Plan, taskId: string, options: TesterTaskOptions): ReturnType<MainAgentRuntime["executeTestTask"]>;
  summarize(input: MainSummaryInput): Promise<string>;
}

function createTrace(): OrchestrationTrace {
  return { calledAgents: [], events: [] };
}

function recordTrace(trace: OrchestrationTrace, event: OrchestrationTraceEvent) {
  if (!trace.calledAgents.includes(event.agent)) trace.calledAgents.push(event.agent);
  trace.events.push(event);
}

function cloneTrace(trace?: OrchestrationTrace): OrchestrationTrace {
  return trace
    ? { calledAgents: [...trace.calledAgents], events: trace.events.map((event) => ({ ...event })) }
    : createTrace();
}

/** 阶段 6 的统一控制器：Main 负责路由和 DAG 推进，各专业 Agent 仍由独立 Runtime 执行。 */
export class MainAgentOrchestrator {
  constructor(
    private readonly runtime: MainOrchestrationRuntimeFacade = new MainAgentRuntime(),
    private readonly maxSteps = DEFAULT_MAX_ORCHESTRATION_STEPS
  ) {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw runtimeError("INVALID_CONTRACT", "编排最大步数必须是正整数。", { maxSteps });
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
      trace: prepared.trace
    });
  }

  async executePlan(
    decision: RouteDecision,
    initialPlan: Plan,
    options: ExecuteOrchestrationPlanOptions = {}
  ): Promise<MainOrchestrationResult> {
    validatePlan(initialPlan);
    let plan = initialPlan;
    const trace = cloneTrace(options.trace);
    if (!trace.calledAgents.includes("main")) recordTrace(trace, { agent: "main", action: "route" });
    const results: AgentResult[] = [];
    const executions: OrchestrationExecution[] = [];
    const changedFiles = uniqueStrings(options.initialChangedFiles ?? []);

    for (let step = 0; step < this.maxSteps; step += 1) {
      if (plan.tasks.every((task) => task.status === "completed")) {
        const summary = await this.runtime.summarize({
          goal: plan.goal,
          routeDecision: decision,
          results,
          changedFiles
        });
        recordTrace(trace, { agent: "main", action: "finish" });
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

      let execution: OrchestrationExecution | null = null;
      if (task.type === "explore") {
        const explored = await this.runtime.executeExploreTask(plan, task.id, options.context ?? {});
        execution = { agent: "explorer", execution: explored };
      } else if (task.type === "implement") {
        const developed = await this.runtime.executeDeveloperTask(plan, task.id, {
          context: options.context,
          constraints: options.constraints
        });
        execution = { agent: "developer", execution: developed };
      } else if (task.type === "test") {
        if (!changedFiles.length) {
          recordTrace(trace, { agent: "main", action: "stop", taskId: task.id });
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
            : acceptanceEvidenceForTask(task, options.acceptanceEvidence)
        });
        execution = { agent: "tester", execution: tested };
      } else {
        const responded = applyMainRespondTask(plan, task);
        plan = responded.plan;
        results.push(responded.result);
        recordTrace(trace, { agent: "main", action: "execute", taskId: task.id, status: "success" });
        continue;
      }

      executions.push(execution);
      await options.onExecution?.(execution);
      const result = execution.execution.result;
      results.push(result);
      changedFiles.splice(0, changedFiles.length, ...uniqueStrings([...changedFiles, ...result.changedFiles]));
      const nextPlan = execution.execution.state.plan;
      if (!nextPlan) throw runtimeError("INVALID_CONTRACT", `${execution.agent} 执行后缺少 Runtime Plan。`);
      plan = nextPlan;
      recordTrace(trace, {
        agent: execution.agent,
        action: "execute",
        taskId: result.taskId,
        status: result.status
      });
      if (result.status !== "success") {
        recordTrace(trace, { agent: "main", action: "stop", taskId: result.taskId, status: result.status });
        return {
          status: result.status,
          decision,
          plan,
          summary: result.summary,
          changedFiles,
          results,
          executions,
          trace
        };
      }
    }

    throw runtimeError("AGENT_LOOP_LIMIT_EXCEEDED", `编排循环超过最大步数 ${this.maxSteps}。`, {
      maxSteps: this.maxSteps
    });
  }
}
