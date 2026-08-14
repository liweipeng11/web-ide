import { END, Send, START, StateGraph } from "@langchain/langgraph";
import type { ExplorerExecution } from "../../agents/explorer/explorerAgentRuntime.js";
import type {
  MainAgentExplorationPlanningResult,
  MainAgentRequest,
  MainAgentReplanRequest
} from "../../agents/main/mainAgentRuntime.js";
import type { MainReplanDecision, ReplanPolicyInput } from "../../agents/main/replanPolicy.js";
import { DEFAULT_MAX_REPLANS, SAME_TASK_FAILURE_REPLAN_THRESHOLD } from "../../agents/main/replanPolicy.js";
import type { PlannerCreatePlanInput, PlannerResult } from "../../agents/planner/contracts.js";
import { createAgentState, validatePlan } from "../../runtime/stateManager.js";
import type { Plan, RouteDecision, Task } from "../../runtime/contracts.js";
import { PlanningGraphState } from "./planningGraphState.js";

export type PlanningGraphRuntime = {
  route: (goal: string, signal?: AbortSignal) => Promise<RouteDecision>;
  createPlan: (input: PlannerCreatePlanInput) => Promise<PlannerResult>;
  replan: (request: MainAgentReplanRequest) => Promise<PlannerResult>;
  executeExploreTask: (
    plan: Plan,
    taskId: string,
    context?: unknown,
    options?: { signal?: AbortSignal }
  ) => Promise<ExplorerExecution>;
  shouldReplan: (input: ReplanPolicyInput) => Promise<MainReplanDecision>;
};

export type PlanningGraphOptions = {
  maxConcurrency: number;
  maxReplans?: number;
};

function unique(values: string[] | undefined): string[] {
  return [...new Set(values?.map((item) => item.trim()).filter(Boolean) ?? [])];
}

function runnableExploreTasks(plan: Plan): Task[] {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return plan.tasks.filter((task) =>
    task.type === "explore"
    && (task.status === "pending" || task.status === "blocked")
    && task.dependencies.every((dependency) => completed.has(dependency))
  );
}

function contextExplorationPlan(goal: string, required: string[], readScope: string[]): Plan {
  const task: Task = {
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
  return {
    version: 1,
    goal,
    assumptions: [],
    tasks: [task],
    completionCriteria: [...task.acceptanceCriteria]
  };
}

function explorationFacts(executions: ExplorerExecution[]): string[] {
  return executions.flatMap((execution) => {
    if (!execution.exploration) return execution.result.facts;
    return [
      ...execution.exploration.facts.map((fact) => `${fact.statement}（证据：${fact.evidence.join("、")}）`),
      ...execution.exploration.relevantFiles.map((filePath) => `相关文件：${filePath}`)
    ];
  });
}

/**
 * 构建 Planner / Explorer 只读子图。所有模型与工具调用仍委托现有 Runtime，Graph 只负责控制流。
 */
export async function runPlanningGraph(
  request: MainAgentRequest,
  runtime: PlanningGraphRuntime,
  options: PlanningGraphOptions
): Promise<MainAgentExplorationPlanningResult> {
  if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new Error("规划图 maxConcurrency 必须是正整数。");
  }
  const maxReplans = options.maxReplans ?? DEFAULT_MAX_REPLANS;
  const goal = request.goal.trim();
  const readScope = unique(request.readScope);
  const writeScope = unique(request.writeScope);

  const graph = new StateGraph(PlanningGraphState)
    .addNode("route", async () => ({ decision: await runtime.route(goal, request.signal), status: "planning" as const }))
    .addNode("planner", async (state) => {
      if (state.decision.route !== "planned") return { planning: null, status: "ready" as const };
      const planning = await runtime.createPlan({
        goal,
        knownFacts: unique([...(request.knownFacts ?? []), ...state.facts]),
        constraints: request.constraints ?? [],
        state: createAgentState(goal),
        readScope,
        writeScope: state.decision.intent === "code_change" ? writeScope : [],
        signal: request.signal
      });
      if (planning.status === "ready") validatePlan(planning.plan);
      return {
        planning,
        ...(planning.status === "ready" ? { plan: planning.plan } : {}),
        ...(planning.status === "missing_context" ? { contextRequirements: planning.required } : {}),
        status: planning.status === "failed" ? "blocked" as const : "planning" as const
      };
    })
    .addNode("prepare_context", async (state) => ({
      plan: contextExplorationPlan(goal, state.contextRequirements, readScope),
      explorationSource: "planner_missing_context" as const,
      status: "exploring" as const
    }))
    .addNode("prepare_ready_exploration", async () => ({
      explorationSource: "planner_ready_task" as const,
      status: "exploring" as const
    }))
    .addNode("explorer", async (state) => {
      if (!state.plan || !state.explorerTaskId) throw new Error("Explorer 节点缺少计划或任务标识。");
      const execution = await runtime.executeExploreTask(
        state.plan,
        state.explorerTaskId,
        state.explorationSource === "planner_missing_context"
          ? { source: state.explorationSource, required: state.contextRequirements }
          : { source: state.explorationSource },
        { signal: request.signal }
      );
      return { explorerResults: [execution], explorations: [execution] };
    })
    .addNode("merge_explorations", async (state) => {
      if (!state.plan) throw new Error("探索合并节点缺少计划。");
      const batch = state.explorerResults.slice(state.processedExplorerResults);
      const statuses = new Map(batch.map((execution) => [execution.result.taskId, execution.result.status]));
      const plan: Plan = {
        ...state.plan,
        tasks: state.plan.tasks.map((task) => {
          const status = statuses.get(task.id);
          if (!status) return task;
          return { ...task, status: status === "success" ? "completed" : status };
        })
      };
      validatePlan(plan);
      // 并行 Explorer 基于同一快照运行，合并后统一回写，避免最后完成者覆盖同批结果。
      for (const execution of batch) execution.state.plan = plan;
      return {
        plan,
        planning: { status: "ready" as const, plan },
        processedExplorerResults: state.explorerResults.length,
        facts: explorationFacts(batch),
        latestFailureTaskId: batch.find((execution) => execution.result.status !== "success")?.result.taskId ?? null
      };
    })
    .addNode("retry_or_replan", async (state) => {
      if (!state.plan) throw new Error("重规划节点缺少计划。");
      const failed = state.latestFailureTaskId
        ? [...state.explorerResults].reverse().find((execution) => execution.result.taskId === state.latestFailureTaskId)
        : undefined;
      if (!failed) return {};
      const taskId = failed.result.taskId;
      const failures = (state.failureCounts[taskId] ?? 0) + 1;
      if (failed.result.status === "failed" && failures < SAME_TASK_FAILURE_REPLAN_THRESHOLD) {
        return {
          failureCounts: { [taskId]: failures },
          plan: {
            ...state.plan,
            tasks: state.plan.tasks.map((task) => task.id === taskId ? { ...task, status: "pending" as const } : task)
          }
        };
      }
      const decision = await runtime.shouldReplan({ plan: state.plan, result: failed.result, sameTaskFailures: failures });
      if (!decision.shouldReplan) {
        return {
          failureCounts: { [taskId]: failures },
          planning: {
            status: "failed" as const,
            reason: "model_error" as const,
            blockers: failed.result.blockers.length ? failed.result.blockers : [`Explorer 任务 ${taskId} 未能完成。`]
          },
          status: "blocked" as const
        };
      }
      if (state.replanCount >= maxReplans) {
        return {
          planning: {
            status: "failed" as const,
            reason: "invalid_plan" as const,
            blockers: [`重规划次数已达到上限 ${maxReplans}。`]
          },
          status: "blocked" as const
        };
      }
      const planning = await runtime.replan({
        oldPlan: state.plan,
        completedTasks: state.plan.tasks.filter((task) => task.status === "completed").map((task) => task.id),
        newFacts: state.facts,
        constraints: request.constraints,
        readScope,
        writeScope,
        signal: request.signal
      });
      if (planning.status === "ready") validatePlan(planning.plan);
      return {
        failureCounts: { [taskId]: failures },
        planning,
        ...(planning.status === "ready" ? { plan: planning.plan } : {}),
        replans: [{ taskId, reason: decision.reason, status: planning.status }],
        replanCount: state.replanCount + 1,
        status: planning.status === "ready" ? "planning" as const : "blocked" as const
      };
    })
    .addNode("replan_after_context", async (state) => {
      const planning = await runtime.createPlan({
        goal,
        knownFacts: unique([...(request.knownFacts ?? []), ...state.facts]),
        constraints: request.constraints ?? [],
        state: createAgentState(goal),
        readScope,
        writeScope: state.decision.intent === "code_change" ? writeScope : [],
        signal: request.signal
      });
      if (planning.status === "ready") validatePlan(planning.plan);
      return {
        planning,
        ...(planning.status === "ready" ? { plan: planning.plan } : {}),
        status: planning.status === "failed" ? "blocked" as const : "planning" as const
      };
    })
    .addNode("finish", async (state) => ({ status: state.planning?.status === "ready" || state.planning === null ? "ready" as const : "blocked" as const }))
    .addEdge(START, "route")
    .addEdge("route", "planner")
    .addConditionalEdges("planner", (state) => {
      if (state.planning === null || state.planning?.status === "failed") return "finish";
      if (state.planning?.status === "missing_context") return readScope.length ? "context" : "finish";
      return "ready";
    }, { finish: "finish", context: "prepare_context", ready: "prepare_ready_exploration" })
    .addConditionalEdges("prepare_context", (state) => dispatchExplorers(state, options.maxConcurrency))
    .addConditionalEdges("prepare_ready_exploration", (state) => dispatchExplorers(state, options.maxConcurrency))
    .addEdge("explorer", "merge_explorations")
    .addConditionalEdges("merge_explorations", (state) => {
      if (state.explorationSource === "planner_missing_context") {
        const latest = state.explorerResults.at(-1);
        return latest?.result.status === "success" ? "context_ready" : "finish";
      }
      return "evaluate";
    }, { context_ready: "replan_after_context", evaluate: "retry_or_replan", finish: "finish" })
    .addConditionalEdges("replan_after_context", (state) => state.planning?.status === "ready" ? "ready" : "finish", {
      ready: "prepare_ready_exploration",
      finish: "finish"
    })
    .addConditionalEdges("retry_or_replan", (state) => {
      if (state.status === "blocked") return "finish";
      return state.planning?.status === "ready" ? "continue" : "finish";
    }, { continue: "prepare_ready_exploration", finish: "finish" })
    .addEdge("finish", END)
    .compile();

  const result = await graph.invoke({
    decision: { intent: "analysis", complexity: "complex", route: "planned", requiredCapabilities: [] },
    planning: null,
    status: "planning",
    facts: unique(request.knownFacts),
    explorations: [],
    explorerResults: [],
    processedExplorerResults: 0,
    replans: [],
    replanCount: 0,
    failureCounts: {},
    contextRequirements: [],
    explorationSource: "planner_ready_task",
    latestFailureTaskId: null
  }, { recursionLimit: 100 });

  return {
    decision: result.decision,
    planning: result.planning,
    explorations: result.explorations,
    replans: result.replans
  };
}

function dispatchExplorers(
  state: typeof PlanningGraphState.State,
  maxConcurrency: number
): Array<Send<"explorer", Partial<typeof PlanningGraphState.State>>> | "finish" {
  if (!state.plan) return "finish";
  const tasks = runnableExploreTasks(state.plan).slice(0, maxConcurrency);
  if (!tasks.length) return "finish";
  return tasks.map((task) => new Send("explorer", { ...state, explorerTaskId: task.id }));
}
