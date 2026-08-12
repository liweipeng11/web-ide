import type {
  AgentResult,
  AgentTaskPacket,
  Plan,
  RouteDecision,
  RuntimeExecutionResult,
  RuntimeTool,
  Task,
  TaskType
} from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager, validatePlan } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import { runtimeError } from "../../runtime/errors.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import type { PlannerResult } from "../planner/contracts.js";
import { PlannerAgent } from "../planner/plannerAgent.js";
import { PlannerAgentRuntime } from "../planner/plannerAgentRuntime.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import { ExplorerAgentRuntime } from "../explorer/explorerAgentRuntime.js";
import type { DeveloperTaskOptions } from "../developer/developerAgentRuntime.js";
import { DeveloperAgentRuntime } from "../developer/developerAgentRuntime.js";
import type { TesterTaskOptions } from "../tester/testerAgentRuntime.js";
import { TesterAgentRuntime } from "../tester/testerAgentRuntime.js";
import { MainAgent } from "./mainAgent.js";
import type { MainSummaryInput } from "./mainAgent.js";
import type { ReplanPolicyInput } from "./replanPolicy.js";
import { DEFAULT_MAX_REPLANS, SAME_TASK_FAILURE_REPLAN_THRESHOLD } from "./replanPolicy.js";
import { config } from "../../config.js";

export type MainAgentRequest = {
  goal: string;
  knownFacts?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  readScope?: string[];
  writeScope?: string[];
  allowedTools?: string[];
  signal?: AbortSignal;
};

export type MainAgentRuntimeResult =
  | {
      outcome: "executed";
      decision: RouteDecision;
      execution: RuntimeExecutionResult;
    }
  | {
      outcome: "planning";
      decision: RouteDecision;
      planning: PlannerResult;
    };

export type MainAgentPlanningResult = {
  decision: RouteDecision;
  planning: PlannerResult | null;
};

export type MainAgentExplorationPlanningResult = MainAgentPlanningResult & {
  explorations: ExplorerExecution[];
  replans?: Array<{
    taskId: string;
    reason: string;
    status: PlannerResult["status"];
  }>;
};

export type MainAgentReplanRequest = {
  oldPlan: Plan;
  completedTasks: string[];
  newFacts?: string[];
  constraints?: string[];
  readScope?: string[];
  writeScope?: string[];
  signal?: AbortSignal;
};

export type MainAgentReplanExecution = {
  planning: PlannerResult;
  explorations: ExplorerExecution[];
};

export type DeveloperScopeChangeDecision =
  | {
      action: "expand_task";
      plan: Plan;
      addedScope: string[];
    }
  | {
      action: "replan";
      reason: string;
      requiredScope: string[];
      requiresAuthorization: boolean;
    };

export type MainAgentRuntimeOptions = {
  agent?: MainAgent;
  planner?: PlannerAgent;
  plannerRuntime?: Pick<PlannerAgentRuntime, "createPlan" | "replan">;
  explorer?: Pick<ExplorerAgentRuntime, "executePlanTask">;
  developer?: Pick<DeveloperAgentRuntime, "executePlanTask">;
  tester?: Pick<TesterAgentRuntime, "executePlanTask">;
  tools?: RuntimeTool[];
  allowedTools?: string[];
  /** 计划准备阶段同层 explore 任务的最大并发数，默认复用运行时稳定性策略。 */
  explorationConcurrency?: number;
};

function taskTypeFor(decision: RouteDecision): TaskType {
  if (decision.intent === "code_change") return "implement";
  if (decision.intent === "question") return "respond";
  return "explore";
}

function createTask(goal: string, decision: RouteDecision, request: MainAgentRequest, allowedTools: string[]): AgentTaskPacket {
  const acceptanceCriteria = request.acceptanceCriteria?.map((item) => item.trim()).filter(Boolean)
    ?? ["Main Agent 已返回明确结果"];
  if (!acceptanceCriteria.length) {
    throw runtimeError("INVALID_CONTRACT", "Main Agent 请求至少需要一条验收标准。");
  }
  return {
    taskId: "MAIN-1",
    goal,
    context: { routeDecision: decision },
    constraints: request.constraints ?? [],
    acceptanceCriteria,
    readScope: request.readScope ?? [],
    // 只读意图即使收到调用方 writeScope，也不会把写权限带入任务。
    writeScope: decision.intent === "code_change" ? request.writeScope ?? [] : [],
    allowedTools
  };
}

function createPlan(task: AgentTaskPacket, decision: RouteDecision): Plan {
  return {
    version: 1,
    goal: task.goal,
    assumptions: [],
    tasks: [{
      id: task.taskId,
      type: taskTypeFor(decision),
      goal: task.goal,
      dependencies: [],
      // planned 只用于识别边界；阶段 1 不要求 Main 自己具备 Planner 的执行能力。
      requiredCapabilities: decision.route === "planned" ? [] : decision.requiredCapabilities,
      readScope: task.readScope,
      writeScope: task.writeScope,
      acceptanceCriteria: task.acceptanceCriteria,
      status: "pending"
    }],
    completionCriteria: [...task.acceptanceCriteria]
  };
}

/** 用户请求进入新 Runtime 的正式服务边界，调用方必须显式提供可用工具和访问范围。 */
export class MainAgentRuntime {
  private readonly agent: MainAgent;
  private readonly planner: PlannerAgent;
  private readonly plannerRuntime: Pick<PlannerAgentRuntime, "createPlan" | "replan">;
  private readonly explorer: Pick<ExplorerAgentRuntime, "executePlanTask">;
  private readonly developer: Pick<DeveloperAgentRuntime, "executePlanTask">;
  private readonly tester: Pick<TesterAgentRuntime, "executePlanTask">;
  private readonly tools: ToolRegistry;
  private readonly policyTools: string[];
  private readonly explorationConcurrency: number;

  constructor(options: MainAgentRuntimeOptions = {}) {
    this.agent = options.agent ?? new MainAgent();
    this.planner = options.planner ?? new PlannerAgent();
    this.plannerRuntime = options.plannerRuntime ?? new PlannerAgentRuntime(this.planner);
    this.explorer = options.explorer ?? new ExplorerAgentRuntime();
    this.developer = options.developer ?? new DeveloperAgentRuntime();
    this.tester = options.tester ?? new TesterAgentRuntime();
    this.tools = new ToolRegistry(options.tools ?? []);
    this.policyTools = [...new Set(options.allowedTools ?? [])];
    this.explorationConcurrency = options.explorationConcurrency ?? config.agentRuntimeStabilityPolicy.maxConcurrency;
  }

  async execute(request: MainAgentRequest): Promise<MainAgentRuntimeResult> {
    const goal = request.goal.trim();
    if (!goal) throw runtimeError("INVALID_CONTRACT", "用户目标不能为空。");

    const planningResult = await this.plan(request);
    const { decision } = planningResult;
    if (planningResult.planning) {
      const planning = planningResult.planning;
      return { outcome: "planning", decision, planning };
    }

    return this.executeDecision(request, decision);
  }

  /** 执行 Main 已确认的 direct/main_loop 决策，供上层编排器避免重复模型路由。 */
  async executeDecision(request: MainAgentRequest, decision: RouteDecision): Promise<MainAgentRuntimeResult> {
    const goal = request.goal.trim();
    if (!goal) throw runtimeError("INVALID_CONTRACT", "用户目标不能为空。");
    if (decision.route === "planned") {
      throw runtimeError("INVALID_CONTRACT", "planned 决策必须进入 Planner，不能直接执行。");
    }

    const requestedTools = request.allowedTools ?? this.policyTools;
    const policyToolSet = new Set(this.policyTools);
    const available = this.tools.describeAvailable(requestedTools)
      .filter((tool) => policyToolSet.has(tool.name))
      .filter((tool) => decision.intent === "code_change" || tool.effect !== "write");
    const allowedTools = available.map((tool) => tool.name);
    const task = createTask(goal, decision, request, decision.route === "direct" ? [] : allowedTools);
    const initialState = createAgentState(goal, createPlan(task, decision));
    // Direct 不调用 Explorer；由入口显式提供的已读上下文必须进入事实区，避免脱离代码内容作答。
    initialState.facts = [...new Set(request.knownFacts?.map((item) => item.trim()).filter(Boolean) ?? [])];
    const state = new StateManager(initialState);
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: this.tools,
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: this.policyTools }]),
      state,
      executionPolicy: config.agentRuntimeStabilityPolicy
    });

    return {
      outcome: "executed",
      decision,
      execution: await kernel.execute(this.agent.id, task, { signal: request.signal })
    };
  }

  /** 仅执行 Main 路由和 Planner，不会误入 direct/main_loop 的工具执行阶段。 */
  async plan(request: MainAgentRequest): Promise<MainAgentPlanningResult> {
    const goal = request.goal.trim();
    if (!goal) throw runtimeError("INVALID_CONTRACT", "用户目标不能为空。");
    const decision = await this.agent.route(goal, request.signal);
    if (decision.route !== "planned") return { decision, planning: null };

    const planning = await this.plannerRuntime.createPlan({
      goal,
      knownFacts: request.knownFacts ?? [],
      constraints: request.constraints ?? [],
      state: createAgentState(goal),
      readScope: request.readScope ?? [],
      writeScope: decision.intent === "code_change" ? request.writeScope ?? [] : [],
      signal: request.signal
    });
    return { decision, planning };
  }

  /** Main 只调度 Plan 中明确声明的 explore Task，不在阶段 3 执行实现或测试任务。 */
  executeExploreTask(plan: Plan, taskId: string, context: unknown = {}, options: { signal?: AbortSignal } = {}) {
    return this.explorer.executePlanTask(plan, taskId, context, options);
  }

  /** Main 仅在显式执行阶段调度 implement Task；计划初始化不会自动进入该入口。 */
  executeDeveloperTask(plan: Plan, taskId: string, options: DeveloperTaskOptions = {}) {
    return this.developer.executePlanTask(plan, taskId, options);
  }

  /** Main 显式调度只读 test Task；阶段 5 不在 Developer 完成后自动触发测试。 */
  executeTestTask(plan: Plan, taskId: string, options: TesterTaskOptions) {
    return this.tester.executePlanTask(plan, taskId, options);
  }

  summarize(input: MainSummaryInput) {
    return this.agent.summarize(input);
  }

  shouldReplan(input: ReplanPolicyInput) {
    return this.agent.shouldReplan(input);
  }

  /** Main 只在用户总授权内处理小范围扩展；更大或越权的变化交回重规划。 */
  resolveDeveloperScopeChange(
    plan: Plan,
    taskId: string,
    result: AgentResult,
    authorizedScope: { readScope: string[]; writeScope: string[] }
  ): DeveloperScopeChangeDecision {
    validatePlan(plan);
    if (result.status !== "blocked" || !result.scopeChangeRequest) {
      throw runtimeError("INVALID_CONTRACT", "只有 Developer 的 blocked 范围申请可以进入范围决策。", { taskId });
    }
    const task = plan.tasks.find((item) => item.id === taskId);
    if (!task) throw runtimeError("TASK_NOT_FOUND", `计划中不存在任务 ${taskId}。`, { taskId });
    if (task.type !== "implement") {
      throw runtimeError("INVALID_CONTRACT", `任务 ${taskId} 不是 implement Task。`, { taskId });
    }

    const requiredScope = [...new Set(result.scopeChangeRequest.requiredScope.map((item) => item.trim()).filter(Boolean))];
    if (!requiredScope.length || requiredScope.some((filePath) => !isPathInScope(filePath, ["**"]))) {
      throw runtimeError("SCOPE_VIOLATION", "Developer 范围申请包含无效路径。", { requiredScope });
    }
    const addedScope = requiredScope.filter((filePath) => !isPathInScope(filePath, task.writeScope));
    const withinAuthorization = addedScope.every((filePath) =>
      isPathInScope(filePath, authorizedScope.readScope)
      && isPathInScope(filePath, authorizedScope.writeScope)
    );
    if (!addedScope.length || addedScope.length > 3 || !withinAuthorization) {
      return {
        action: "replan",
        reason: withinAuthorization
          ? "范围变化较大或没有形成有效的新写入范围，需要重新规划。"
          : "所需写入路径超出用户授权范围，需要重新规划或请求用户确认。",
        requiredScope,
        requiresAuthorization: !withinAuthorization
      };
    }

    const nextPlan: Plan = {
      ...plan,
      version: plan.version + 1,
      assumptions: [...plan.assumptions],
      completionCriteria: [...plan.completionCriteria],
      tasks: plan.tasks.map((item) => item.id === taskId
        ? {
            ...item,
            dependencies: [...item.dependencies],
            requiredCapabilities: [...item.requiredCapabilities],
            // 修改已有文件前 Developer 必须读取目标，因此同步扩展读写边界。
            readScope: [...new Set([...item.readScope, ...addedScope])],
            writeScope: [...new Set([...item.writeScope, ...addedScope])],
            acceptanceCriteria: [...item.acceptanceCriteria],
            status: "pending" as const
          }
        : {
            ...item,
            dependencies: [...item.dependencies],
            requiredCapabilities: [...item.requiredCapabilities],
            readScope: [...item.readScope],
            writeScope: [...item.writeScope],
            acceptanceCriteria: [...item.acceptanceCriteria]
          })
    };
    validatePlan(nextPlan);
    return { action: "expand_task", plan: nextPlan, addedScope };
  }

  private async executeRunnableExploreTasks(
    planning: Extract<PlannerResult, { status: "ready" }>,
    previousExplorations: ExplorerExecution[] = [],
    replanContext: Pick<MainAgentRequest, "constraints" | "readScope" | "writeScope" | "signal"> = {}
  ) {
    let plan = planning.plan;
    const explorations = [...previousExplorations];
    const replans: NonNullable<MainAgentExplorationPlanningResult["replans"]> = [];
    const failureCounts = new Map<string, number>();

    while (true) {
      const completedTaskIds = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
      const runnableTasks = plan.tasks.filter((candidate) =>
        candidate.type === "explore"
        && (candidate.status === "pending" || candidate.status === "blocked")
        && candidate.dependencies.every((dependency) => completedTaskIds.has(dependency))
      );
      if (!runnableTasks.length) break;

      // 同一依赖层的探索均为只读任务，可受限并发；合并结果时始终回写同一份 Plan，避免各自 State 覆盖。
      const taskBatch = runnableTasks.slice(0, this.explorationConcurrency);
      const batchPlan = plan;
      const batchExecutions = await Promise.all(taskBatch.map((task) =>
        this.executeExploreTask(batchPlan, task.id, { source: "planner_ready_task" }, { signal: replanContext.signal })
      ));
      for (const execution of batchExecutions) {
        if (!execution.state.plan) {
          throw runtimeError("INVALID_CONTRACT", `Explorer 执行后没有返回 Plan 状态：${execution.result.taskId}`, { taskId: execution.result.taskId });
        }
      }
      const statusByTaskId = new Map(batchExecutions.map((execution) => [execution.result.taskId, execution.result.status]));
      plan = {
        ...batchPlan,
        tasks: batchPlan.tasks.map((item) => {
          const status = statusByTaskId.get(item.id);
          return status ? { ...item, status: status === "success" ? "completed" as const : status } : item;
        })
      };
      for (const execution of batchExecutions) execution.state.plan = plan;
      explorations.push(...batchExecutions);

      let replanned = false;
      for (const execution of batchExecutions) {
        const taskId = execution.result.taskId;
        if (execution.result.status === "failed") {
          const failures = (failureCounts.get(taskId) ?? 0) + 1;
          failureCounts.set(taskId, failures);
          if (failures < SAME_TASK_FAILURE_REPLAN_THRESHOLD) {
            plan = { ...plan, tasks: plan.tasks.map((item) => item.id === taskId ? { ...item, status: "pending" as const } : item) };
            continue;
          }
        }

        const replanDecision = await this.agent.shouldReplan({ plan, result: execution.result, sameTaskFailures: failureCounts.get(taskId) ?? 0 });
        if (execution.result.status !== "success" && !replanDecision.shouldReplan) {
          return {
            planning: {
              status: "failed",
              reason: "model_error",
              blockers: execution.result.blockers.length ? execution.result.blockers : [`Explorer 任务 ${taskId} 未能完成。`]
            } as const,
            explorations,
            replans
          };
        }
        if (!replanDecision.shouldReplan) continue;
        if (replans.length >= DEFAULT_MAX_REPLANS) {
          const limitFailure: PlannerResult = {
            status: "failed",
            reason: "invalid_plan",
            blockers: [`重规划次数已达到上限 ${DEFAULT_MAX_REPLANS}。`]
          };
          return {
            planning: limitFailure,
            explorations,
            replans
          };
        }
        const replanning = await this.replanWithExploration({
          oldPlan: plan,
          completedTasks: plan.tasks.filter((item) => item.status === "completed").map((item) => item.id),
          newFacts: [...new Set(explorations.flatMap((item) => item.result.facts))],
          constraints: replanContext.constraints,
          readScope: replanContext.readScope,
          writeScope: replanContext.writeScope
        });
        explorations.push(...replanning.explorations);
        replans.push({ taskId, reason: replanDecision.reason, status: replanning.planning.status });
        if (replanning.planning.status !== "ready") {
          return { planning: replanning.planning, explorations, replans };
        }
        plan = replanning.planning.plan;
        replanned = true;
        break;
      }
      if (replanned) continue;
    }

    return {
      planning: { status: "ready", plan } as const,
      explorations,
      replans
    };
  }

  /** Planner 缺少仓库事实时执行一次受限探索，再把压缩事实交回 Planner。 */
  async planWithExploration(request: MainAgentRequest): Promise<MainAgentExplorationPlanningResult> {
    const initial = await this.plan(request);
    if (initial.planning?.status === "ready") {
      const executed = await this.executeRunnableExploreTasks(initial.planning, [], request);
      return { decision: initial.decision, ...executed };
    }
    if (initial.planning?.status !== "missing_context") {
      return { ...initial, explorations: [] };
    }

    const readScope = [...new Set(request.readScope?.map((item) => item.trim()).filter(Boolean) ?? [])];
    if (!readScope.length) {
      // 没有显式读取范围时不得自动把 Explorer 升级为全仓库访问。
      return { ...initial, explorations: [] };
    }

    const required = initial.planning.required;
    const explorationTask: Task = {
      id: "EXPLORE-CONTEXT-1",
      type: "explore",
      goal: `补充 Planner 所需仓库事实：${required.join("；")}`,
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope,
      writeScope: [],
      acceptanceCriteria: required.map((item) => `确认并提供证据：${item}`),
      status: "pending"
    };
    const explorationPlan: Plan = {
      version: 1,
      goal: request.goal.trim(),
      assumptions: [],
      tasks: [explorationTask],
      completionCriteria: [...explorationTask.acceptanceCriteria]
    };
    const exploration = await this.executeExploreTask(explorationPlan, explorationTask.id, {
      source: "planner_missing_context",
      required
    }, { signal: request.signal });
    if (exploration.result.status !== "success" || !exploration.exploration) {
      return { ...initial, explorations: [exploration] };
    }

    const facts = exploration.exploration.facts.map((fact) => `${fact.statement}（证据：${fact.evidence.join("、")}）`);
    const relevantFiles = exploration.exploration.relevantFiles.map((filePath) => `相关文件：${filePath}`);
    const planning = await this.planner.createPlan({
      goal: request.goal.trim(),
      knownFacts: [...new Set([...(request.knownFacts ?? []), ...facts, ...relevantFiles])],
      constraints: request.constraints ?? [],
      state: createAgentState(request.goal.trim()),
      readScope,
      writeScope: initial.decision.intent === "code_change" ? request.writeScope ?? [] : [],
      signal: request.signal
    });
    if (planning.status === "ready") {
      const executed = await this.executeRunnableExploreTasks(planning, [exploration], request);
      return { decision: initial.decision, ...executed };
    }
    return { decision: initial.decision, planning, explorations: [exploration] };
  }

  /** Main 持有重规划入口；Planner 只返回新计划，不直接修改真实 AgentState。 */
  async replan(request: MainAgentReplanRequest): Promise<PlannerResult> {
    validatePlan(request.oldPlan);
    const completedTasks = [...new Set(request.completedTasks)];
    const state = createAgentState(request.oldPlan.goal, request.oldPlan);
    state.completedTasks = completedTasks;
    state.facts = [...new Set(request.newFacts ?? [])];

    return this.plannerRuntime.replan({
      oldPlan: request.oldPlan,
      completedTasks,
      newFacts: request.newFacts ?? [],
      constraints: request.constraints ?? [],
      readScope: request.readScope ?? [...new Set(request.oldPlan.tasks.flatMap((task) => task.readScope))],
      writeScope: request.writeScope ?? [...new Set(request.oldPlan.tasks.flatMap((task) => task.writeScope))],
      state,
      signal: request.signal
    });
  }

  /** Replan 缺少仓库事实时执行一次只读探索，再携带压缩事实重试 Planner。 */
  async replanWithExploration(request: MainAgentReplanRequest): Promise<MainAgentReplanExecution> {
    const initial = await this.replan(request);
    if (initial.status !== "missing_context") return { planning: initial, explorations: [] };

    const readScope = request.readScope
      ?? [...new Set(request.oldPlan.tasks.flatMap((task) => task.readScope))];
    if (!readScope.length) return { planning: initial, explorations: [] };
    const task: Task = {
      id: `EXPLORE-REPLAN-CONTEXT-${request.oldPlan.version + 1}`,
      type: "explore",
      goal: `补充重规划所需仓库事实：${initial.required.join("；")}`,
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope,
      writeScope: [],
      acceptanceCriteria: initial.required.map((item) => `确认并提供证据：${item}`),
      status: "pending"
    };
    const explorationPlan: Plan = {
      version: 1,
      goal: request.oldPlan.goal,
      assumptions: [...request.oldPlan.assumptions],
      tasks: [task],
      completionCriteria: [...task.acceptanceCriteria]
    };
    const exploration = await this.executeExploreTask(explorationPlan, task.id, {
      source: "planner_replan_missing_context",
      required: initial.required
    }, { signal: request.signal });
    if (exploration.result.status !== "success") {
      return {
        planning: {
          status: "failed",
          reason: "model_error",
          blockers: exploration.result.blockers.length
            ? exploration.result.blockers
            : ["Explorer 未能补充重规划所需上下文。"]
        },
        explorations: [exploration]
      };
    }
    return {
      planning: await this.replan({
        ...request,
        newFacts: [...new Set([...(request.newFacts ?? []), ...exploration.result.facts])]
      }),
      explorations: [exploration]
    };
  }
}
