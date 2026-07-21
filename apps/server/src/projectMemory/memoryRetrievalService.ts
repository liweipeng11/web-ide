import { ConservativeTokenEstimator } from "../contextBudget/index.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { buildBudgetedProjectMemoryPrompt } from "./memoryPromptBudget.js";
import { rankProjectMemoryItems } from "./memoryScoring.js";
import { getProjectMemory } from "./projectMemoryService.js";
import type { MemoryRetrievalContext, ProjectMemory, ProjectMemoryRetrievalResult } from "./types.js";

const DEFAULT_MAX_ITEMS = 8;
const DEFAULT_TOKEN_BUDGET = 1_200;

function inferLanguages(paths: string[]) {
  const extensionLanguages: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", vue: "Vue", py: "Python", java: "Java", go: "Go", rs: "Rust" };
  return [...new Set(paths.map((file) => extensionLanguages[file.toLowerCase().split(".").pop() || ""]).filter((value): value is string => Boolean(value)))];
}

function inferFrameworks(userRequest: string) {
  const supported = ["React", "Vue", "Express", "Vite", "Next.js", "NestJS"];
  return supported.filter((framework) => userRequest.toLowerCase().includes(framework.toLowerCase()));
}

export function normalizeMemoryRetrievalContext(context: Partial<MemoryRetrievalContext> & Pick<MemoryRetrievalContext, "userRequest">): MemoryRetrievalContext {
  const contextPaths = [...new Set(context.contextPaths || [])];
  const plannedFiles = [...new Set(context.plannedFiles || [])];
  return {
    userRequest: context.userRequest.trim(),
    contextPaths,
    plannedFiles,
    languages: [...new Set(context.languages?.length ? context.languages : inferLanguages([...contextPaths, ...plannedFiles]))],
    frameworks: [...new Set(context.frameworks?.length ? context.frameworks : inferFrameworks(context.userRequest))],
    branch: context.branch?.trim() || undefined,
    maxItems: Math.max(0, Math.min(50, Math.floor(context.maxItems ?? DEFAULT_MAX_ITEMS))),
    tokenBudget: Math.max(128, Math.min(8_000, Math.floor(context.tokenBudget ?? DEFAULT_TOKEN_BUDGET)))
  };
}

/** 对已加载数据执行纯召回，便于离线评测同一上下文得到完全一致的结果。 */
export function retrieveProjectMemory(memory: ProjectMemory, input: Partial<MemoryRetrievalContext> & Pick<MemoryRetrievalContext, "userRequest">, now = Date.now()): ProjectMemoryRetrievalResult {
  const context = normalizeMemoryRetrievalContext(input);
  const ranked = rankProjectMemoryItems(memory.items, context, now);
  const budgeted = buildBudgetedProjectMemoryPrompt(memory, ranked, { tokenBudget: context.tokenBudget, context });
  const included = new Set(budgeted.includedItemIds);
  return {
    prompt: budgeted.prompt,
    selectedItems: ranked.filter((entry) => included.has(entry.item.id)),
    estimatedTokens: budgeted.estimatedTokens,
    tokenBudget: context.tokenBudget,
    snapshotTokenBudget: budgeted.snapshotTokenBudget,
    memoryTokenBudget: budgeted.memoryTokenBudget
  };
}

/** 所有模型入口调用的统一服务；无工作区时维持空 Prompt 的旧行为。 */
export async function getRelevantProjectMemory(input: Partial<MemoryRetrievalContext> & Pick<MemoryRetrievalContext, "userRequest">): Promise<ProjectMemoryRetrievalResult> {
  const context = normalizeMemoryRetrievalContext(input);
  if (!getWorkspaceRoot()) {
    return { prompt: "", selectedItems: [], estimatedTokens: 0, tokenBudget: context.tokenBudget, snapshotTokenBudget: 0, memoryTokenBudget: 0 };
  }
  return retrieveProjectMemory(await getProjectMemory(), context);
}

export async function getRelevantProjectMemoryPrompt(input: Partial<MemoryRetrievalContext> & Pick<MemoryRetrievalContext, "userRequest">) {
  return (await getRelevantProjectMemory(input)).prompt;
}
