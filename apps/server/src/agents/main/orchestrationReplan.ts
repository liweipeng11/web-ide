import type { AgentResult, Plan } from "../../runtime/contracts.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import type {
  DeveloperScopeChangeDecision,
  MainAgentReplanExecution,
  MainAgentReplanRequest
} from "./mainAgentRuntime.js";
import type { MainReplanDecision, ReplanPolicyInput } from "./replanPolicy.js";
import type { OrchestrationAgentId, OrchestrationTraceEvent } from "./orchestrationContracts.js";
import { uniqueStrings } from "./orchestrationPlan.js";
import { SAME_TASK_FAILURE_REPLAN_THRESHOLD } from "./replanPolicy.js";

export interface OrchestrationReplanRuntime {
  shouldReplan(input: ReplanPolicyInput): Promise<MainReplanDecision>;
  replanWithExploration(request: MainAgentReplanRequest): Promise<MainAgentReplanExecution>;
  resolveDeveloperScopeChange(
    plan: Plan,
    taskId: string,
    result: AgentResult,
    authorizedScope: { readScope: string[]; writeScope: string[] }
  ): DeveloperScopeChangeDecision;
}

type ReplanTransition = {
  action: "continue" | "stop";
  plan: Plan;
  replanCount: number;
  planUpdate?: "scope_expansion" | "retry" | "replan";
  traceEvent?: OrchestrationTraceEvent;
  status?: "failed" | "blocked";
  summary?: string;
  explorations?: ExplorerExecution[];
};

function retryFailedTask(plan: Plan, taskId: string): Plan {
  return {
    ...plan,
    assumptions: [...plan.assumptions],
    completionCriteria: [...plan.completionCriteria],
    tasks: plan.tasks.map((task) => task.id === taskId
      ? { ...task, status: "pending" as const }
      : task)
  };
}

/** 根据单次 Agent 结果决定继续、修订任务、重规划或安全停止。 */
export async function handleOrchestrationReplan(input: {
  runtime: OrchestrationReplanRuntime;
  agent: OrchestrationAgentId;
  plan: Plan;
  result: AgentResult;
  results: AgentResult[];
  failureCounts: Map<string, number>;
  authorizedScope: { readScope: string[]; writeScope: string[] };
  constraints?: string[];
  replanCount: number;
  maxReplans: number;
}): Promise<ReplanTransition> {
  let forceReason: string | undefined;
  if (input.agent === "developer" && input.result.status === "blocked" && input.result.scopeChangeRequest) {
    const scopeDecision = input.runtime.resolveDeveloperScopeChange(
      input.plan,
      input.result.taskId,
      input.result,
      input.authorizedScope
    );
    if (scopeDecision.action === "expand_task") {
      return {
        action: "continue",
        plan: scopeDecision.plan,
        replanCount: input.replanCount,
        planUpdate: "scope_expansion"
      };
    }
    if (scopeDecision.requiresAuthorization) {
      return {
        action: "stop",
        plan: input.plan,
        replanCount: input.replanCount,
        status: "blocked",
        summary: scopeDecision.reason
      };
    }
    forceReason = scopeDecision.reason;
  }

  if (input.result.status !== "success") {
    input.failureCounts.set(input.result.taskId, (input.failureCounts.get(input.result.taskId) ?? 0) + 1);
  }
  const decision = await input.runtime.shouldReplan({
    plan: input.plan,
    result: input.result,
    sameTaskFailures: input.failureCounts.get(input.result.taskId) ?? 0,
    forceReason
  });
  if (!decision.shouldReplan) {
    if (input.result.status === "success") {
      return { action: "continue", plan: input.plan, replanCount: input.replanCount };
    }
    const failureCount = input.failureCounts.get(input.result.taskId) ?? 0;
    if (input.result.status === "failed"
      && !input.result.changedFiles.length
      && failureCount < SAME_TASK_FAILURE_REPLAN_THRESHOLD) {
      return {
        action: "continue",
        plan: retryFailedTask(input.plan, input.result.taskId),
        replanCount: input.replanCount,
        planUpdate: "retry"
      };
    }
    return {
      action: "stop",
      plan: input.plan,
      replanCount: input.replanCount,
      status: input.result.status,
      summary: input.result.summary
    };
  }

  if (input.replanCount >= input.maxReplans) {
    return {
      action: "stop",
      plan: input.plan,
      replanCount: input.replanCount,
      status: "blocked",
      summary: `重规划次数已达到上限 ${input.maxReplans}，编排已安全停止。`
    };
  }

  const replanning = await input.runtime.replanWithExploration({
    oldPlan: input.plan,
    completedTasks: input.plan.tasks.filter((task) => task.status === "completed").map((task) => task.id),
    newFacts: uniqueStrings(input.results.flatMap((result) => result.facts)),
    constraints: input.constraints,
    readScope: input.authorizedScope.readScope,
    writeScope: input.authorizedScope.writeScope
  });
  const planning = replanning.planning;
  const traceEvent: OrchestrationTraceEvent = {
    agent: "planner",
    action: "replan",
    taskId: input.result.taskId,
    status: planning.status === "ready" ? "ready" : planning.status === "missing_context" ? "missing_context" : "failed",
    reason: decision.reason
  };
  if (planning.status === "ready") {
    return {
      action: "continue",
      plan: planning.plan,
      replanCount: input.replanCount + 1,
      planUpdate: "replan",
      traceEvent,
      explorations: replanning.explorations
    };
  }
  return {
    action: "stop",
    plan: input.plan,
    replanCount: input.replanCount + 1,
    status: "blocked",
    summary: planning.status === "missing_context"
      ? `Planner 重规划需要补充上下文：${planning.required.join("；")}`
      : planning.blockers.join("；") || "Planner 重规划失败。",
    traceEvent,
    explorations: replanning.explorations
  };
}
