import { buildBudgetedProjectMemoryPrompt } from "./memoryPromptBudget.js";
import { rankProjectMemoryItems } from "./memoryScoring.js";
import type { ProjectMemory } from "./types.js";

/** 兼容旧调用方；新模型入口应传入真实任务上下文调用统一召回服务。 */
export function buildProjectMemoryPrompt(memory: ProjectMemory) {
  const snapshot = memory.snapshot;
  const context = {
    userRequest: [snapshot.projectSummary, ...snapshot.currentGoals, ...snapshot.confirmedRisks, ...memory.items.map((item) => item.content)].join(" "),
    contextPaths: snapshot.recentChanges.flatMap((change) => change.files),
    plannedFiles: [],
    languages: snapshot.techStack.languages,
    frameworks: snapshot.techStack.frameworks,
    maxItems: 3,
    tokenBudget: 1_600
  };
  const ranked = rankProjectMemoryItems(memory.items, context, memory.updatedAt);
  return buildBudgetedProjectMemoryPrompt(memory, ranked, { tokenBudget: context.tokenBudget, context }).prompt;
}
