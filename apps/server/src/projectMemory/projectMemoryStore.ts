import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { PROJECT_MEMORY_SCHEMA_VERSION, type ProjectMemory, type ProjectMemoryPendingItem, type ProjectMemoryRecentChange, type ProjectMemoryTechStack } from "./types.js";

const memoryRelativePath = path.join(".mini-ai", "state", "runtime", "project-memory.json");
const legacyMemoryRelativePath = path.join(".ai-agent", "project-memory.json");
const writeQueues = new Map<string, Promise<unknown>>();

function memoryPath(workspaceRoot: string) {
  return path.join(workspaceRoot, memoryRelativePath);
}

function legacyMemoryPath(workspaceRoot: string) {
  return path.join(workspaceRoot, legacyMemoryRelativePath);
}

function normalizeString(value: unknown, maxLength = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeStringArray(value: unknown, maxItems = 30, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeString(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function normalizeTechStack(value: unknown): ProjectMemoryTechStack {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<ProjectMemoryTechStack>) : {};

  return {
    packageManager: typeof record.packageManager === "string" && record.packageManager.trim() ? record.packageManager.trim() : null,
    languages: normalizeStringArray(record.languages),
    frameworks: normalizeStringArray(record.frameworks),
    buildTools: normalizeStringArray(record.buildTools),
    lintTools: normalizeStringArray(record.lintTools),
    typeSystems: normalizeStringArray(record.typeSystems),
    testTools: normalizeStringArray(record.testTools),
    workspacePackages: normalizeStringArray(record.workspacePackages, 50),
    scannedAt: typeof record.scannedAt === "number" && Number.isFinite(record.scannedAt) ? record.scannedAt : Date.now()
  };
}

function normalizeRecentChanges(value: unknown): ProjectMemoryRecentChange[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<ProjectMemoryRecentChange> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      taskSessionId: normalizeString(item.taskSessionId, 200),
      summary: normalizeString(item.summary, 1_000),
      files: normalizeStringArray(item.files, 50, 500),
      changedAt: typeof item.changedAt === "number" && Number.isFinite(item.changedAt) ? item.changedAt : Date.now()
    }))
    .filter((item) => item.taskSessionId && item.summary)
    .sort((left, right) => right.changedAt - left.changedAt)
    .slice(0, 20);
}

function normalizePendingItems(value: unknown): ProjectMemoryPendingItem[] {
  const validStatuses = new Set<ProjectMemoryPendingItem["status"]>(["running", "awaiting_approval", "awaiting_user", "paused", "success", "failed", "cancelled", "awaiting_replan"]);
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Partial<ProjectMemoryPendingItem> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      taskSessionId: normalizeString(item.taskSessionId, 200),
      summary: normalizeString(item.summary, 1_000),
      status: validStatuses.has(item.status as ProjectMemoryPendingItem["status"]) ? (item.status as ProjectMemoryPendingItem["status"]) : "running",
      updatedAt: typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now()
    }))
    .filter((item) => item.taskSessionId && item.summary)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 20);
}

/** 读取旧版本或外部编辑后的 JSON 时统一收敛结构，避免无界内容进入模型上下文。 */
export function normalizeProjectMemory(value: unknown): ProjectMemory {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<ProjectMemory>) : {};
  const now = Date.now();

  return {
    schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
    projectSummary: normalizeString(record.projectSummary, 4_000),
    // 旧版本没有来源字段时按手工内容保护；服务层刷新时会识别与旧自动摘要完全相同的值。
    projectSummarySource: record.projectSummarySource === "generated" ? "generated" : "manual",
    techStack: normalizeTechStack(record.techStack),
    conventions: normalizeStringArray(record.conventions),
    currentGoals: normalizeStringArray(record.currentGoals),
    recentChanges: normalizeRecentChanges(record.recentChanges),
    pendingItems: normalizePendingItems(record.pendingItems),
    confirmedRisks: normalizeStringArray(record.confirmedRisks),
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : now
  };
}

async function readOptionalFile(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function readProjectMemory(workspaceRoot: string): Promise<ProjectMemory | null> {
  const primary = await readOptionalFile(memoryPath(workspaceRoot));
  const raw = primary ?? (await readOptionalFile(legacyMemoryPath(workspaceRoot)));
  if (raw === null) return null;

  try {
    return normalizeProjectMemory(JSON.parse(raw));
  } catch {
    throw new HttpError(500, "Project memory file contains invalid JSON");
  }
}

export async function writeProjectMemory(workspaceRoot: string, memory: ProjectMemory): Promise<ProjectMemory> {
  const targetPath = memoryPath(workspaceRoot);
  const normalized = normalizeProjectMemory(memory);
  const previous = writeQueues.get(targetPath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;

    // 先写临时文件再替换，避免进程中断留下半截 JSON。
    await fs.writeFile(temporaryPath, JSON.stringify(normalized, null, 2), "utf8");
    await fs.rename(temporaryPath, targetPath).catch(async (error) => {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    });
    return normalized;
  });

  writeQueues.set(targetPath, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(targetPath) === next) writeQueues.delete(targetPath);
  }
}
