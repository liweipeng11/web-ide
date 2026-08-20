import { Annotation } from "@langchain/langgraph";
import type { ExplorerExecution } from "../../agents/explorer/explorerAgentRuntime.js";
import type { MainAgentExplorationPlanningResult } from "../../agents/main/mainAgentRuntime.js";
import type { PlannerResult } from "../../agents/planner/contracts.js";
import type { Plan, RouteDecision } from "../../runtime/contracts.js";

export type PlanningGraphStatus = "planning" | "exploring" | "ready" | "blocked";

export type PlanningGraphReplan = NonNullable<MainAgentExplorationPlanningResult["replans"]>[number];

/**
 * 规划图只保存结构化计划、事实和探索产物，不保存 Prompt、文件正文或工具原始输出。
 * 数组 reducer 用于安全汇聚同一 super-step 中并行返回的 Explorer 结果。
 */
export const PlanningGraphState = Annotation.Root({
  decision: Annotation<RouteDecision>,
  planning: Annotation<PlannerResult | null>,
  plan: Annotation<Plan | undefined>,
  status: Annotation<PlanningGraphStatus>,
  facts: Annotation<string[]>({ reducer: uniqueReducer, default: () => [] }),
  explorations: Annotation<ExplorerExecution[]>({ reducer: appendReducer, default: () => [] }),
  explorerResults: Annotation<ExplorerExecution[]>({ reducer: appendReducer, default: () => [] }),
  processedExplorerResults: Annotation<number>({ reducer: (_current, next) => next, default: () => 0 }),
  replans: Annotation<PlanningGraphReplan[]>({ reducer: appendReducer, default: () => [] }),
  replanCount: Annotation<number>({ reducer: (_current, next) => next, default: () => 0 }),
  failureCounts: Annotation<Record<string, number>>({
    reducer: (current, next) => ({ ...current, ...next }),
    default: () => ({})
  }),
  contextRequirements: Annotation<string[]>({ reducer: (_current, next) => [...next], default: () => [] }),
  explorationSource: Annotation<"planner_missing_context" | "planner_ready_task">,
  explorerTaskId: Annotation<string | undefined>,
  latestEvaluationTaskIds: Annotation<string[]>({ reducer: (_current, next) => [...next], default: () => [] })
});

function appendReducer<T>(current: T[], next: T[]): T[] {
  return [...current, ...next];
}

function uniqueReducer(current: string[], next: string[]): string[] {
  return [...new Set([...current, ...next].map((item) => item.trim()).filter(Boolean))];
}
