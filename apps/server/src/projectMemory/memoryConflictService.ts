import type { ProjectMemory, ProjectMemoryItem } from "./types.js";

function canonical(value: string) {
  return value.toLocaleLowerCase().replace(/[\s。；;，,！!？?]/g, "");
}

function conflictCore(content: string) {
  return canonical(content).replace(/(?:不要|不得|禁止|不允许|必须|应当|应该|mustnot|donot|never|must|should)/g, "");
}

function isNegative(content: string) {
  return /(?:不要|不得|禁止|不允许|不应|must\s+not|do\s+not|never)/i.test(content);
}

function sameScope(left: ProjectMemoryItem, right: ProjectMemoryItem) {
  return JSON.stringify(left.scope) === JSON.stringify(right.scope);
}

/** 新确认事实只替代同类型、同作用域且语义核心相反的旧事实。 */
export function findSupersededMemoryIds(items: ProjectMemoryItem[], replacement: ProjectMemoryItem) {
  const core = conflictCore(replacement.content);
  if (!core) return [];
  return items
    .filter((item) => item.id !== replacement.id && item.status === "active" && item.kind === replacement.kind && sameScope(item, replacement))
    .filter((item) => conflictCore(item.content) === core && isNegative(item.content) !== isNegative(replacement.content))
    .filter((item) => item.updatedAt <= replacement.updatedAt)
    .map((item) => item.id);
}

export function supersedeConflictingMemories(memory: ProjectMemory, replacementId: string, now = Date.now()): ProjectMemory {
  const replacement = memory.items.find((item) => item.id === replacementId);
  if (!replacement || replacement.status !== "active") return memory;
  const supersededIds = new Set(findSupersededMemoryIds(memory.items, replacement));
  if (!supersededIds.size) return memory;
  return {
    ...memory,
    items: memory.items.map((item) => supersededIds.has(item.id)
      ? { ...item, status: "superseded" as const, validationStatus: "superseded" as const, supersededBy: replacement.id, updatedAt: now }
      : item)
  };
}
