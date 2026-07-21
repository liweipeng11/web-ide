import type { ProjectMemory, ProjectMemoryItem } from "./types.js";

const AUTO_ARCHIVE_AFTER_MS = 180 * 86_400_000;
const RECENT_CHANGE_RETENTION_MS = 90 * 86_400_000;

export type MemoryLifecycleOptions = {
  now?: number;
  autoArchiveAfterMs?: number;
  recentChangeRetentionMs?: number;
  completedTaskSummaries?: ReadonlySet<string>;
};

function applyItemLifecycle(item: ProjectMemoryItem, now: number, autoArchiveAfterMs: number): ProjectMemoryItem {
  if (item.status !== "active" && item.status !== "stale") return item;
  if (item.expiresAt !== undefined && item.expiresAt <= now) {
    // 用户确认的架构/决策事实只降级，不自动删除；自动事实则直接归档。
    return item.createdBy === "user" && (item.kind === "decision" || item.kind === "convention")
      ? { ...item, status: "stale", validationStatus: "possibly_stale", updatedAt: now }
      : { ...item, status: "archived", validationStatus: "archived", updatedAt: now };
  }
  const lastActivityAt = item.lastUsedAt ?? item.updatedAt;
  if (item.createdBy !== "user" && now - lastActivityAt >= autoArchiveAfterMs) {
    return { ...item, status: "archived", validationStatus: "archived", updatedAt: now };
  }
  if (item.kind === "risk" && /(?:已解决|已修复|resolved|fixed)/i.test(item.content)) {
    return { ...item, status: "archived", validationStatus: "archived", updatedAt: now };
  }
  return item;
}

/** 生命周期维护是纯数据转换，不读取或修改工作区代码。 */
export function applyMemoryLifecycle(memory: ProjectMemory, options: MemoryLifecycleOptions = {}): ProjectMemory {
  const now = options.now ?? Date.now();
  const autoArchiveAfterMs = options.autoArchiveAfterMs ?? AUTO_ARCHIVE_AFTER_MS;
  const retentionMs = options.recentChangeRetentionMs ?? RECENT_CHANGE_RETENTION_MS;
  const items = memory.items.map((item) => applyItemLifecycle(item, now, autoArchiveAfterMs));
  const recentChanges = memory.snapshot.recentChanges
    .filter((change) => now - change.changedAt <= retentionMs)
    .sort((left, right) => right.changedAt - left.changedAt)
    .slice(0, 20);
  const completedTaskSummaries = options.completedTaskSummaries ?? new Set<string>();
  const currentGoals = memory.snapshot.currentGoals.filter((goal) => !completedTaskSummaries.has(goal));
  return { ...memory, snapshot: { ...memory.snapshot, currentGoals, recentChanges }, items };
}
