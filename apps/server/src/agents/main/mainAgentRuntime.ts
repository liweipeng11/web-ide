import type {
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
import type { PlannerResult } from "../planner/contracts.js";
import { PlannerAgent } from "../planner/plannerAgent.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import { ExplorerAgentRuntime } from "../explorer/explorerAgentRuntime.js";
import { MainAgent } from "./mainAgent.js";

export type MainAgentRequest = {
  goal: string;
  knownFacts?: string[];
  constraints?: string[];
  acceptanceCriteria?: string[];
  readScope?: string[];
  writeScope?: string[];
  allowedTools?: string[];
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
};

export type MainAgentReplanRequest = {
  oldPlan: Plan;
  completedTasks: string[];
  newFacts?: string[];
  constraints?: string[];
  readScope?: string[];
  writeScope?: string[];
};

export type MainAgentRuntimeOptions = {
  agent?: MainAgent;
  planner?: PlannerAgent;
  explorer?: Pick<ExplorerAgentRuntime, "executePlanTask">;
  tools?: RuntimeTool[];
  allowedTools?: string[];
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
  private readonly explorer: Pick<ExplorerAgentRuntime, "executePlanTask">;
  private readonly tools: ToolRegistry;
  private readonly policyTools: string[];

  constructor(options: MainAgentRuntimeOptions = {}) {
    this.agent = options.agent ?? new MainAgent();
    this.planner = options.planner ?? new PlannerAgent();
    this.explorer = options.explorer ?? new ExplorerAgentRuntime();
    this.tools = new ToolRegistry(options.tools ?? []);
    this.policyTools = [...new Set(options.allowedTools ?? [])];
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

    const requestedTools = request.allowedTools ?? this.policyTools;
    const policyToolSet = new Set(this.policyTools);
    const available = this.tools.describeAvailable(requestedTools)
      .filter((tool) => policyToolSet.has(tool.name))
      .filter((tool) => decision.intent === "code_change" || tool.effect !== "write");
    const allowedTools = available.map((tool) => tool.name);
    const task = createTask(goal, decision, request, decision.route === "direct" ? [] : allowedTools);
    const state = new StateManager(createAgentState(goal, createPlan(task, decision)));
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: this.tools,
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: this.policyTools }]),
      state
    });

    return {
      outcome: "executed",
      decision,
      execution: await kernel.execute(this.agent.id, task)
    };
  }

  /** 仅执行 Main 路由和 Planner，不会误入 direct/main_loop 的工具执行阶段。 */
  async plan(request: MainAgentRequest): Promise<MainAgentPlanningResult> {
    const goal = request.goal.trim();
    if (!goal) throw runtimeError("INVALID_CONTRACT", "用户目标不能为空。");
    const decision = await this.agent.route(goal);
    if (decision.route !== "planned") return { decision, planning: null };

    const planning = await this.planner.createPlan({
      goal,
      knownFacts: request.knownFacts ?? [],
      constraints: request.constraints ?? [],
      state: createAgentState(goal),
      readScope: request.readScope ?? [],
      writeScope: decision.intent === "code_change" ? request.writeScope ?? [] : []
    });
    return { decision, planning };
  }

  /** Main 只调度 Plan 中明确声明的 explore Task，不在阶段 3 执行实现或测试任务。 */
  executeExploreTask(plan: Plan, taskId: string, context: unknown = {}) {
    return this.explorer.executePlanTask(plan, taskId, context);
  }

  private async executeRunnableExploreTasks(
    planning: Extract<PlannerResult, { status: "ready" }>,
    previousExplorations: ExplorerExecution[] = []
  ) {
    let plan = planning.plan;
    const explorations = [...previousExplorations];

    while (true) {
      const completedTaskIds = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
      const task = plan.tasks.find((candidate) =>
        candidate.type === "explore"
        && (candidate.status === "pending" || candidate.status === "blocked")
        && candidate.dependencies.every((dependency) => completedTaskIds.has(dependency))
      );
      if (!task) break;

      const execution = await this.executeExploreTask(plan, task.id, { source: "planner_ready_task" });
      explorations.push(execution);
      if (execution.result.status !== "success") {
        return {
          planning: {
            status: "failed",
            reason: "model_error",
            blockers: execution.result.blockers.length
              ? execution.result.blockers
              : [`Explorer 任务 ${task.id} 未能完成。`]
          } as const,
          explorations
        };
      }
      // Runtime 持有真实 Task 状态；Main 只接收更新后的 Plan 和结构化探索制品。
      if (!execution.state.plan) {
        throw runtimeError("INVALID_CONTRACT", `Explorer 执行后没有返回 Plan 状态：${task.id}`, { taskId: task.id });
      }
      plan = execution.state.plan;
    }

    return {
      planning: { status: "ready", plan } as const,
      explorations
    };
  }

  /** Planner 缺少仓库事实时执行一次受限探索，再把压缩事实交回 Planner。 */
  async planWithExploration(request: MainAgentRequest): Promise<MainAgentExplorationPlanningResult> {
    const initial = await this.plan(request);
    if (initial.planning?.status === "ready") {
      const executed = await this.executeRunnableExploreTasks(initial.planning);
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
    });
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
      writeScope: initial.decision.intent === "code_change" ? request.writeScope ?? [] : []
    });
    if (planning.status === "ready") {
      const executed = await this.executeRunnableExploreTasks(planning, [exploration]);
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

    return this.planner.replan({
      oldPlan: request.oldPlan,
      completedTasks,
      newFacts: request.newFacts ?? [],
      constraints: request.constraints ?? [],
      readScope: request.readScope ?? [...new Set(request.oldPlan.tasks.flatMap((task) => task.readScope))],
      writeScope: request.writeScope ?? [...new Set(request.oldPlan.tasks.flatMap((task) => task.writeScope))],
      state
    });
  }
}
