import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getWorkspaceRoot } from "../workspaceStore.js";
import type { MemoryRetrievalContext, MemoryUsageRecord, ScoredProjectMemoryItem } from "./types.js";
import { findSensitiveMemoryReason } from "./memorySanitizer.js";
import { isProjectMemoryFeatureEnabled } from "./projectMemoryFeatureFlags.js";

const usageRelativePath = path.join(".mini-ai", "state", "runtime", "project-memory-usage.json");
const MAX_USAGE_RECORDS = 30;
const writeQueues = new Map<string, Promise<unknown>>();

function usagePath(workspaceRoot: string) {
  return path.join(workspaceRoot, usageRelativePath);
}

async function readRecords(workspaceRoot: string): Promise<MemoryUsageRecord[]> {
  const content = await fs.readFile(usagePath(workspaceRoot), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "[]";
    throw error;
  });
  try {
    const value = JSON.parse(content);
    if (!Array.isArray(value)) return [];
    // 兼容阶段 5 的日志格式，但读取时移除可能遗留的完整正文和来源值。
    return value.slice(0, MAX_USAGE_RECORDS).map((record: any) => ({
      ...record,
      requestSummary: safePreview(record.requestSummary),
      entries: Array.isArray(record.entries) ? record.entries.map((entry: any) => ({
        itemId: String(entry.itemId || ""),
        contentPreview: safePreview(entry.contentPreview ?? entry.content),
        score: typeof entry.score === "number" ? entry.score : null,
        reasons: Array.isArray(entry.reasons) ? entry.reasons.filter((item: unknown) => typeof item === "string").slice(0, 20) : [],
        sourceTypes: Array.isArray(entry.sourceTypes)
          ? entry.sourceTypes
          : Array.isArray(entry.sourceRefs) ? entry.sourceRefs.map((source: any) => source?.type).filter(Boolean) : [],
        validationStatus: entry.validationStatus,
        includedInPrompt: entry.includedInPrompt === true,
        ...(entry.exclusionReason ? { exclusionReason: entry.exclusionReason } : {})
      })) : []
    })) as MemoryUsageRecord[];
  } catch {
    // 可解释性日志损坏不能影响主任务；管理界面会以空记录安全降级。
    return [];
  }
}

function safePreview(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return "";
  const reason = findSensitiveMemoryReason(value);
  if (reason) return `[已脱敏:${reason}]`;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

export async function listMemoryUsageRecords(workspaceRoot = getWorkspaceRoot(), limit = 10) {
  if (!workspaceRoot) return [];
  return (await readRecords(workspaceRoot)).slice(0, Math.max(1, Math.min(30, limit)));
}

/** 记录排序后但因预算未进入 Prompt 的项，便于管理界面解释选择结果。 */
export async function recordMemoryRetrievalUsage(options: {
  workspaceRoot?: string | null;
  context: MemoryRetrievalContext;
  rankedItems: ScoredProjectMemoryItem[];
  consideredItemIds: ReadonlySet<string>;
  includedItemIds: ReadonlySet<string>;
  estimatedTokens: number;
}) {
  if (!isProjectMemoryFeatureEnabled("usageLogEnabled")) return;
  const workspaceRoot = options.workspaceRoot ?? getWorkspaceRoot();
  if (!workspaceRoot) return;
  const entries = options.rankedItems.map((entry) => ({
    itemId: entry.item.id,
    contentPreview: safePreview(entry.item.content),
    score: entry.score,
    reasons: entry.reasons,
    sourceTypes: [...new Set(entry.item.sourceRefs.map((source) => source.type))],
    validationStatus: entry.item.validationStatus,
    includedInPrompt: options.includedItemIds.has(entry.item.id),
    ...(options.includedItemIds.has(entry.item.id) ? {} : { exclusionReason: options.consideredItemIds.has(entry.item.id) ? "token_budget" as const : "item_limit" as const })
  }));
  const record: MemoryUsageRecord = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    requestSummary: safePreview(options.context.userRequest),
    contextPaths: [...new Set([...options.context.contextPaths, ...options.context.plannedFiles])].slice(0, 30),
    tokenBudget: options.context.tokenBudget,
    estimatedTokens: options.estimatedTokens,
    entries
  };
  const target = usagePath(workspaceRoot);
  const previous = writeQueues.get(target) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const records = await readRecords(workspaceRoot);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify([record, ...records].slice(0, MAX_USAGE_RECORDS), null, 2), "utf8");
    await fs.rename(temporary, target);
  });
  writeQueues.set(target, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(target) === next) writeQueues.delete(target);
  }
}
