import crypto from "node:crypto";
import { HttpError } from "../errors.js";
import { getProjectMemory, mutateProjectMemory } from "./projectMemoryService.js";
import {
  ensureMemoryContentIsSafe,
  normalizeMemoryConfidence,
  normalizeMemoryContent,
  normalizeMemoryKind,
  normalizeMemoryScope,
  normalizeMemorySourceRefs
} from "./memorySanitizer.js";
import type { CreateMemoryCandidateInput, ProjectMemoryItem, UpdateMemoryCandidateInput } from "./types.js";
import { supersedeConflictingMemories } from "./memoryConflictService.js";

export type MemoryCandidateMutationResult = {
  candidate: ProjectMemoryItem;
  created: boolean;
  conflictIds: string[];
};

function canonicalContent(content: string) {
  return content.toLocaleLowerCase().replace(/[\s。；;，,！!？?]/g, "");
}

function itemKey(item: Pick<ProjectMemoryItem, "kind" | "content" | "scope">) {
  const scope = item.scope.type === "path" ? { type: "path", paths: [...item.scope.paths].sort() } : { type: "project", paths: [] };
  return JSON.stringify([item.kind, canonicalContent(item.content), scope]);
}

function conflictCore(content: string) {
  return canonicalContent(content).replace(/(?:不要|不得|禁止|不允许|必须|应当|应该|mustnot|donot|never|must|should)/g, "");
}

function isNegative(content: string) {
  return /(?:不要|不得|禁止|不允许|不应|must\s+not|do\s+not|never)/i.test(content);
}

function findConflictIds(items: ProjectMemoryItem[], candidate: ProjectMemoryItem) {
  const core = conflictCore(candidate.content);
  if (!core) return [];
  return items
    .filter((item) => item.id !== candidate.id && item.status === "active" && item.kind === candidate.kind)
    .filter((item) => conflictCore(item.content) === core && isNegative(item.content) !== isNegative(candidate.content))
    .map((item) => item.id);
}

function normalizeCandidateInput(input: CreateMemoryCandidateInput): Omit<ProjectMemoryItem, "id" | "status" | "createdAt" | "updatedAt" | "validationStatus"> {
  const content = normalizeMemoryContent(input.content);
  ensureMemoryContentIsSafe(content);
  if (input.createdBy !== "migration" && input.createdBy !== "user" && input.createdBy !== "system") {
    throw new HttpError(400, "Memory creator is invalid");
  }
  return {
    kind: normalizeMemoryKind(input.kind),
    content,
    scope: normalizeMemoryScope(input.scope),
    sourceRefs: normalizeMemorySourceRefs(input.sourceRefs),
    createdBy: input.createdBy,
    confidence: normalizeMemoryConfidence(input.confidence)
  };
}

export async function listMemoryCandidates(workspaceRoot?: string) {
  const memory = await getProjectMemory({ workspaceRoot });
  return memory.items.filter((item) => item.status === "candidate");
}

/** 所有来源（用户、系统、迁移）统一经过安全检查和精确去重后才能成为候选。 */
export async function createMemoryCandidate(input: CreateMemoryCandidateInput, workspaceRoot?: string): Promise<MemoryCandidateMutationResult> {
  const normalized = normalizeCandidateInput(input);
  let result: MemoryCandidateMutationResult | null = null;
  await mutateProjectMemory((memory) => {
    const duplicate = memory.items.find((item) => itemKey(item) === itemKey(normalized));
    if (duplicate) {
      result = { candidate: duplicate, created: false, conflictIds: findConflictIds(memory.items, duplicate) };
      return memory;
    }
    const now = Date.now();
    const candidate: ProjectMemoryItem = { ...normalized, id: crypto.randomUUID(), status: "candidate", createdAt: now, updatedAt: now, validationStatus: "unverified" };
    result = { candidate, created: true, conflictIds: findConflictIds(memory.items, candidate) };
    return { ...memory, items: [candidate, ...memory.items] };
  }, workspaceRoot);
  if (!result) throw new Error("Failed to create memory candidate");
  return result;
}

export async function updateMemoryCandidate(id: string, input: UpdateMemoryCandidateInput, workspaceRoot?: string) {
  const saved = await mutateProjectMemory((memory) => {
    const index = memory.items.findIndex((item) => item.id === id);
    if (index < 0) throw new HttpError(404, "Memory candidate not found");
    const current = memory.items[index];
    if (current.status !== "candidate") throw new HttpError(409, "Only candidate memory can be edited");
    const next: ProjectMemoryItem = {
      ...current,
      kind: input.kind === undefined ? current.kind : normalizeMemoryKind(input.kind),
      content: input.content === undefined ? current.content : normalizeMemoryContent(input.content),
      scope: input.scope === undefined ? current.scope : normalizeMemoryScope(input.scope),
      updatedAt: Date.now()
    };
    ensureMemoryContentIsSafe(next.content);
    const duplicate = memory.items.find((item) => item.id !== id && itemKey(item) === itemKey(next));
    if (duplicate) throw new HttpError(409, "An equivalent memory item already exists");
    return { ...memory, items: memory.items.map((item) => item.id === id ? next : item) };
  }, workspaceRoot);
  const updated = saved.items.find((item) => item.id === id);
  if (!updated) throw new Error("Failed to update memory candidate");
  return updated;
}

export async function acceptMemoryCandidate(id: string, workspaceRoot?: string) {
  const saved = await mutateProjectMemory((memory) => {
    const candidate = memory.items.find((item) => item.id === id);
    if (!candidate) throw new HttpError(404, "Memory candidate not found");
    if (candidate.status !== "candidate") throw new HttpError(409, "Memory item is not awaiting confirmation");
    const accepted: ProjectMemoryItem = { ...candidate, status: "active", updatedAt: Date.now() };
    return supersedeConflictingMemories({ ...memory, items: memory.items.map((item) => item.id === id ? accepted : item) }, id);
  }, workspaceRoot);
  const accepted = saved.items.find((item) => item.id === id);
  if (!accepted) throw new Error("Failed to accept memory candidate");
  return accepted;
}

/** 拒绝项保留审计记录，但后续召回会严格排除。 */
export async function rejectMemoryCandidate(id: string, workspaceRoot?: string) {
  await mutateProjectMemory((memory) => {
    const candidate = memory.items.find((item) => item.id === id);
    if (!candidate) throw new HttpError(404, "Memory candidate not found");
    if (candidate.status !== "candidate") throw new HttpError(409, "Only candidate memory can be rejected");
    return {
      ...memory,
      items: memory.items.map((item) => item.id === id
        ? { ...item, status: "rejected" as const, validationStatus: "invalid" as const, updatedAt: Date.now() }
        : item)
    };
  }, workspaceRoot);
}

export async function deleteMemoryItem(id: string, workspaceRoot?: string) {
  await mutateProjectMemory((memory) => {
    if (!memory.items.some((item) => item.id === id)) throw new HttpError(404, "Memory item not found");
    return { ...memory, items: memory.items.filter((item) => item.id !== id) };
  }, workspaceRoot);
}
