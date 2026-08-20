import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { MainAgentRequest } from "../../agents/main/mainAgentRuntime.js";
import type { RouteDecision } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import type { AgentStep, TaskSession } from "../../types.js";
import { createGraphAgentStepEmitter } from "../events/graphEventStream.js";
import { TaskSessionCheckpointer } from "../persistence/taskSessionCheckpointer.js";
import {
  graphActionId,
  graphThreadIdForTask
} from "../persistence/threadIdentity.js";
import {
  createMainGraph,
  type MainGraphBranchResult,
  type MainGraphResult
} from "./mainGraph.js";
import type { MainGraphStateValue } from "./mainGraphState.js";

export interface TaskSessionMainGraphResult<T> {
  graph: MainGraphResult;
  value: T;
}

/**
 * 已批准 TaskSession 的 Runtime Plan 已经是 Planning 阶段的持久化结果。
 * 路由只根据计划中的真实任务恢复，不重新调用模型，避免审批后发生计划漂移。
 */
export function routeApprovedTaskSession(session: TaskSession): RouteDecision {
  if (session.agentMode !== "act" || session.planApproval?.status !== "approved") {
    throw runtimeError("INVALID_CONTRACT", "任务计划尚未批准，不能进入 Main Graph 执行分支。");
  }
  if (!session.runtimePlan) {
    throw runtimeError("INVALID_CONTRACT", "已批准任务缺少 Runtime Plan，不能进入 Main Graph。");
  }
  const usesPlanner = session.runtimePlan.tasks.some((task) => task.type === "explore");
  return {
    intent: "code_change",
    complexity: usesPlanner ? "complex" : "medium",
    route: usesPlanner ? "planned" : "main_loop",
    requiredCapabilities: usesPlanner
      ? ["planning", "exploration", "editing", "testing"]
      : ["read", "edit"]
  };
}

/**
 * 用统一 Main Graph 推进已批准任务，同时把真实副作用继续委托给现有流水线。
 * executeOnce 缓存同一次调用的 Promise，防止条件边或恢复逻辑重复启动写入。
 */
export async function runApprovedTaskSessionMainGraph<T extends object>(input: {
  session: TaskSession;
  signal?: AbortSignal;
  checkpointer?: BaseCheckpointSaver;
  onGraphStep?: (step: AgentStep) => Promise<void> | void;
  onGraphEventError?: (error: unknown) => Promise<void> | void;
  execute: () => Promise<T>;
  describe: (value: T) => MainGraphBranchResult;
}): Promise<TaskSessionMainGraphResult<T>> {
  const decision = routeApprovedTaskSession(input.session);
  const checkpointer = input.checkpointer ?? defaultMainGraphCheckpointer();
  const graphRunId = mainGraphRunId(input.session);
  const emitter = createGraphAgentStepEmitter({
    runId: graphRunId,
    seenStepIds: (input.session.steps ?? []).map((step) => step.id),
    onStep: input.onGraphStep,
    onError: input.onGraphEventError
  });
  let executionPromise: Promise<T> | null = null;
  let completedValue: T | null = null;
  let executionError: unknown;
  const executeOnce = async () => {
    await emitter.emit({ type: "node", node: decision.route, phase: "started" });
    try {
      executionPromise ??= input.execute();
      completedValue = await executionPromise;
      const described = input.describe(completedValue);
      await emitter.emit({
        type: "node",
        node: decision.route,
        phase: "completed",
        status: described.outcome === "completed" ? "success" : described.outcome === "failed" ? "failed" : "blocked",
        summary: described.summary
      });
      return described;
    } catch (error) {
      // Main Graph 会把节点异常收敛为 failed state；入口仍需保留原错误供写路径安全门禁判断。
      executionError = error;
      throw error;
    }
  };

  const runtime = createMainGraph({
    async route() {
      await emitter.emit({ type: "node", node: "route", phase: "started" });
      await emitter.emit({ type: "node", node: "route", phase: "completed", status: "success" });
      return decision;
    },
    async runDirect() {
      throw runtimeError("INVALID_CONTRACT", "已批准修改任务不能进入 direct 分支。");
    },
    async runMainLoop() {
      return executeOnce();
    },
    async runPlanning() {
      // 用户批准前已经完成规划；此处恢复同一份持久化计划，不重新规划。
      await emitter.emit({ type: "update", summary: "已恢复用户批准的执行计划。" });
      return { status: "ready", value: input.session.runtimePlan };
    },
    async runPlanned(_request, _route, planning) {
      if (planning !== input.session.runtimePlan) {
        throw runtimeError("INVALID_CONTRACT", "Main Graph 未使用 TaskSession 中已批准的 Runtime Plan。");
      }
      return executeOnce();
    }
  }, { ...(checkpointer ? { checkpointer } : {}) });

  const request: MainAgentRequest = {
    goal: input.session.userGoal,
    signal: input.signal
  };
  const graph = await runtime.invoke(request, mainGraphInvocation(input.session));
  await emitter.emit({ type: "final", summary: graph.summary || "Main Graph 执行结束。" });
  if (executionError) throw executionError;
  if (!completedValue) {
    throw runtimeError("INVALID_CONTRACT", "Main Graph 未执行已批准的任务流水线。", {
      outcome: graph.outcome,
      blockers: graph.blockers
    });
  }
  return { graph, value: completedValue };
}

/** 同一 TaskSession 和计划版本在刷新、重放后保持相同事件 run ID。 */
export function mainGraphRunId(session: TaskSession): string {
  return graphActionId(session.id, graphThreadIdForTask(session.id), `plan-v${session.runtimePlan?.version ?? 0}`);
}

export function mainGraphInvocation(session: TaskSession) {
  return {
    threadId: graphThreadIdForTask(session.id),
    // 根 Graph 必须使用空 namespace；子图隔离由 LangGraph 自行追加 namespace。
    checkpointNamespace: ""
  };
}

function defaultMainGraphCheckpointer(): BaseCheckpointSaver | undefined {
  try {
    return new TaskSessionCheckpointer();
  } catch (error) {
    // 尚未选择工作区时仍允许纯内存测试和只读调用，生产工作区选定后会自动启用文件持久化。
    if (error instanceof Error && error.message === "No workspace selected") return undefined;
    throw error;
  }
}

/** 刷新页面或服务重启后只读取流程快照，不重新执行任何节点。 */
export async function readApprovedTaskSessionMainGraphState(input: {
  session: TaskSession;
  checkpointer?: BaseCheckpointSaver;
}): Promise<Partial<MainGraphStateValue> | null> {
  const unavailable = async () => {
    throw runtimeError("INVALID_CONTRACT", "读取 Main Graph 快照时不应执行节点。");
  };
  const checkpointer = input.checkpointer ?? defaultMainGraphCheckpointer();
  if (!checkpointer) return null;
  const runtime = createMainGraph({
    route: unavailable,
    runDirect: unavailable,
    runMainLoop: unavailable,
    runPlanning: unavailable,
    runPlanned: unavailable
  }, { checkpointer });
  const snapshot = await runtime.graph.getState({
    configurable: {
      thread_id: mainGraphInvocation(input.session).threadId,
      checkpoint_ns: mainGraphInvocation(input.session).checkpointNamespace
    }
  });
  const values = snapshot.values as Partial<MainGraphStateValue>;
  return Object.keys(values).length ? values : null;
}
