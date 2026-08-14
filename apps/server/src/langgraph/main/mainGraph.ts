import { END, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { MainAgentRequest } from "../../agents/main/mainAgentRuntime.js";
import { runtimeError } from "../../runtime/errors.js";
import type { RouteDecision } from "../../runtime/contracts.js";
import {
  MainGraphState,
  type MainGraphBranch,
  type MainGraphOutcome,
  type MainGraphStateValue
} from "./mainGraphState.js";

type TerminalOutcome = Exclude<MainGraphOutcome, "routing" | "planning">;

export interface MainGraphBranchResult {
  outcome: TerminalOutcome;
  summary: string;
  facts?: string[];
  changedFiles?: string[];
  blockers?: string[];
}

export type MainGraphPlanningResult =
  | { status: "ready"; value: unknown; facts?: string[] }
  | { status: "awaiting_user" | "awaiting_approval" | "blocked" | "incomplete" | "cancelled" | "failed"; summary: string; blockers?: string[] };

export interface MainGraphDependencies {
  route: (request: MainAgentRequest) => Promise<RouteDecision>;
  runDirect: (request: MainAgentRequest, decision: RouteDecision) => Promise<MainGraphBranchResult>;
  runMainLoop: (request: MainAgentRequest, decision: RouteDecision) => Promise<MainGraphBranchResult>;
  runPlanning: (request: MainAgentRequest, decision: RouteDecision) => Promise<MainGraphPlanningResult>;
  runPlanned: (request: MainAgentRequest, decision: RouteDecision, planning: unknown) => Promise<MainGraphBranchResult>;
}

export interface MainGraphResult {
  decision: RouteDecision | null;
  branch: MainGraphBranch;
  outcome: TerminalOutcome;
  summary: string;
  planning: unknown | null;
  facts: string[];
  changedFiles: string[];
  blockers: string[];
  history: string[];
}

export type MainGraphOptions = {
  checkpointer?: BaseCheckpointSaver;
};

export type MainGraphInvocationOptions = {
  threadId?: string;
  checkpointNamespace?: string;
};

const ROUTES = new Set<RouteDecision["route"]>(["direct", "main_loop", "planned"]);
const TERMINAL_OUTCOMES = new Set<TerminalOutcome>([
  "completed",
  "awaiting_user",
  "awaiting_approval",
  "blocked",
  "incomplete",
  "cancelled",
  "failed"
]);

function validateDecision(value: RouteDecision): RouteDecision {
  if (!value || !ROUTES.has(value.route) || !Array.isArray(value.requiredCapabilities)) {
    throw runtimeError("INVALID_CONTRACT", "Main Graph 收到无效路由结果。");
  }
  return value;
}

function validateBranchResult(result: MainGraphBranchResult): MainGraphBranchResult {
  if (!result || !TERMINAL_OUTCOMES.has(result.outcome) || !result.summary?.trim()) {
    throw runtimeError("INVALID_CONTRACT", "Main Graph 子图必须返回终态和非空摘要。");
  }
  return result;
}

function failureUpdate(error: unknown, signal?: AbortSignal): Partial<MainGraphStateValue> {
  const cancelled = signal?.aborted || (error instanceof Error && error.name === "AbortError");
  return {
    outcome: cancelled ? "cancelled" : "failed",
    summary: cancelled ? "任务已取消。" : "Main Graph 子图执行失败。",
    blockers: [error instanceof Error ? error.message : String(error)],
    history: [cancelled ? "cancelled" : "failed"]
  };
}

function branchUpdate(branch: Exclude<MainGraphBranch, null>, result: MainGraphBranchResult): Partial<MainGraphStateValue> {
  const valid = validateBranchResult(result);
  return {
    branch,
    outcome: valid.outcome,
    summary: valid.summary.trim(),
    facts: valid.facts ?? [],
    changedFiles: valid.changedFiles ?? [],
    blockers: valid.blockers ?? [],
    history: [`${branch}:${valid.outcome}`]
  };
}

/**
 * 统一组合 direct、main loop 和 planned 分支。各节点只负责编排，模型、工具、审批及副作用
 * 继续由注入的现有 Runtime 或子图执行，避免绕过项目权限边界。
 */
export function createMainGraph(dependencies: MainGraphDependencies, options: MainGraphOptions = {}) {
  const builder = new StateGraph(MainGraphState)
    .addNode("route", async (_state, config) => {
      const request = config.configurable?.request as MainAgentRequest | undefined;
      if (!request) return failureUpdate(new Error("Main Graph 缺少请求配置。"));
      if (request.signal?.aborted) return failureUpdate(new DOMException("任务已取消。", "AbortError"), request.signal);
      try {
        const decision = validateDecision(await dependencies.route(request));
        return { decision, branch: decision.route, outcome: "routing" as const, history: [`route:${decision.route}`] };
      } catch (error) {
        return failureUpdate(error, request.signal);
      }
    })
    .addNode("direct", async (state, config) => runBranch("direct", state, config.configurable?.request, dependencies.runDirect))
    .addNode("main_loop", async (state, config) => runBranch("main_loop", state, config.configurable?.request, dependencies.runMainLoop))
    .addNode("planning_subgraph", async (state, config) => {
      const request = config.configurable?.request as MainAgentRequest | undefined;
      if (!request || !state.decision) return failureUpdate(new Error("规划节点缺少请求或路由结果。"));
      try {
        const planning = await dependencies.runPlanning(request, state.decision);
        if (planning.status === "ready") {
          if (planning.value === undefined || planning.value === null) {
            throw runtimeError("INVALID_CONTRACT", "Planning 子图返回 ready 时必须提供计划结果。");
          }
          return { planning: planning.value, outcome: "planning" as const, facts: planning.facts ?? [], history: ["planning:ready"] };
        }
        if (!planning.summary?.trim()) {
          throw runtimeError("INVALID_CONTRACT", "Planning 子图停止时必须提供摘要。");
        }
        return {
          outcome: planning.status,
          summary: planning.summary.trim(),
          blockers: planning.blockers ?? [],
          history: [`planning:${planning.status}`]
        };
      } catch (error) {
        return failureUpdate(error, request.signal);
      }
    })
    .addNode("planned", async (state, config) => {
      const request = config.configurable?.request as MainAgentRequest | undefined;
      if (!request || !state.decision || state.planning === null) {
        return failureUpdate(new Error("计划执行节点缺少请求、路由结果或计划。"));
      }
      try {
        return branchUpdate("planned", await dependencies.runPlanned(request, state.decision, state.planning));
      } catch (error) {
        return failureUpdate(error, request.signal);
      }
    })
    .addEdge(START, "route")
    .addConditionalEdges("route", (state) => {
      if (state.outcome !== "routing" || !state.decision) return "stop";
      return state.decision.route;
    }, { direct: "direct", main_loop: "main_loop", planned: "planning_subgraph", stop: END })
    .addEdge("direct", END)
    .addEdge("main_loop", END)
    .addConditionalEdges("planning_subgraph", (state) => state.outcome === "planning" ? "execute" : "stop", {
      execute: "planned",
      stop: END
    })
    .addEdge("planned", END);
  const graph = options.checkpointer
    ? builder.compile({ checkpointer: options.checkpointer })
    : builder.compile();

  return {
    graph,
    async invoke(request: MainAgentRequest, invocation: MainGraphInvocationOptions = {}): Promise<MainGraphResult> {
      if (!request.goal.trim()) throw runtimeError("INVALID_CONTRACT", "Main Graph 用户目标不能为空。");
      const result = await graph.invoke({
        decision: null,
        branch: null,
        outcome: "routing",
        summary: "",
        planning: null,
        facts: [],
        changedFiles: [],
        blockers: [],
        history: []
      }, {
        configurable: {
          request,
          ...(invocation.threadId ? { thread_id: invocation.threadId } : {}),
          ...(invocation.checkpointNamespace !== undefined ? { checkpoint_ns: invocation.checkpointNamespace } : {})
        },
        recursionLimit: 20
      });
      if (result.outcome === "routing" || result.outcome === "planning") {
        throw runtimeError("INVALID_CONTRACT", "Main Graph 未收敛到终态。", { outcome: result.outcome });
      }
      return result as MainGraphResult;
    }
  };
}

async function runBranch(
  branch: "direct" | "main_loop",
  state: MainGraphStateValue,
  requestValue: unknown,
  run: (request: MainAgentRequest, decision: RouteDecision) => Promise<MainGraphBranchResult>
) {
  const request = requestValue as MainAgentRequest | undefined;
  if (!request || !state.decision) return failureUpdate(new Error(`${branch} 节点缺少请求或路由结果。`));
  try {
    return branchUpdate(branch, await run(request, state.decision));
  } catch (error) {
    return failureUpdate(error, request.signal);
  }
}
