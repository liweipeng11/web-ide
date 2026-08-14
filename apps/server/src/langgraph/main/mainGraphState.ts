import { Annotation } from "@langchain/langgraph";
import type { RouteDecision } from "../../runtime/contracts.js";

export type MainGraphBranch = "direct" | "main_loop" | "planned" | null;

export type MainGraphOutcome =
  | "routing"
  | "planning"
  | "completed"
  | "awaiting_user"
  | "awaiting_approval"
  | "blocked"
  | "incomplete"
  | "cancelled"
  | "failed";

function uniqueStrings(current: string[], next: string[]) {
  return [...new Set([...current, ...next].map((item) => item.trim()).filter(Boolean))];
}

function appendHistory(current: string[], next: string[]) {
  return [...current, ...next].slice(-100);
}

/**
 * Main Graph 只保存路由、子图引用和有界摘要，不保存 Prompt、源码或原始工具输出。
 */
export const MainGraphState = Annotation.Root({
  decision: Annotation<RouteDecision | null>,
  branch: Annotation<MainGraphBranch>,
  outcome: Annotation<MainGraphOutcome>,
  summary: Annotation<string>,
  planning: Annotation<unknown | null>,
  facts: Annotation<string[]>({ reducer: uniqueStrings, default: () => [] }),
  changedFiles: Annotation<string[]>({ reducer: uniqueStrings, default: () => [] }),
  blockers: Annotation<string[]>({ reducer: uniqueStrings, default: () => [] }),
  history: Annotation<string[]>({ reducer: appendHistory, default: () => [] })
});

export type MainGraphStateValue = typeof MainGraphState.State;
