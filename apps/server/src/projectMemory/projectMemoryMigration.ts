import crypto from "node:crypto";
import { PROJECT_MEMORY_SCHEMA_VERSION, type ProjectMemory, type ProjectMemoryCreatedBy, type ProjectMemoryItem, type ProjectMemoryKind, type ProjectMemoryPendingItem, type ProjectMemoryRecentChange, type ProjectMemoryScope, type ProjectMemorySourceRef, type ProjectMemoryStatus, type ProjectMemoryTechStack, type ProjectMemoryValidationStatus, type ProjectSnapshot } from "./types.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project memory must be an object");
  return value as UnknownRecord;
}

function normalizeString(value: unknown, maxLength = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeStringArray(value: unknown, maxItems = 30, maxLength = 500) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeString(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function normalizeTimestamp(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeTechStack(value: unknown, now: number): ProjectMemoryTechStack {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
  return {
    packageManager: normalizeString(record.packageManager, 100) || null,
    languages: normalizeStringArray(record.languages),
    frameworks: normalizeStringArray(record.frameworks),
    buildTools: normalizeStringArray(record.buildTools),
    lintTools: normalizeStringArray(record.lintTools),
    typeSystems: normalizeStringArray(record.typeSystems),
    testTools: normalizeStringArray(record.testTools),
    workspacePackages: normalizeStringArray(record.workspacePackages, 50),
    scannedAt: normalizeTimestamp(record.scannedAt, now)
  };
}

function normalizeRecentChanges(value: unknown, now: number): ProjectMemoryRecentChange[] {
  if (!Array.isArray(value)) return [];
  const changes = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as UnknownRecord;
    const change = {
      taskSessionId: normalizeString(record.taskSessionId, 200),
      summary: normalizeString(record.summary, 1_000),
      files: normalizeStringArray(record.files, 50, 500),
      changedAt: normalizeTimestamp(record.changedAt, now)
    };
    return change.taskSessionId && change.summary ? [change] : [];
  });
  const byTask = new Map(changes.map((change) => [change.taskSessionId, change]));
  return [...byTask.values()].sort((left, right) => right.changedAt - left.changedAt).slice(0, 20);
}

function normalizePendingItems(value: unknown, now: number): ProjectMemoryPendingItem[] {
  const validStatuses = new Set<ProjectMemoryPendingItem["status"]>(["running", "awaiting_approval", "awaiting_user", "paused", "success", "failed", "cancelled", "awaiting_replan"]);
  if (!Array.isArray(value)) return [];
  const items = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as UnknownRecord;
    const pending = {
      taskSessionId: normalizeString(record.taskSessionId, 200),
      summary: normalizeString(record.summary, 1_000),
      status: validStatuses.has(record.status as ProjectMemoryPendingItem["status"]) ? record.status as ProjectMemoryPendingItem["status"] : "running" as const,
      updatedAt: normalizeTimestamp(record.updatedAt, now)
    };
    return pending.taskSessionId && pending.summary ? [pending] : [];
  });
  const byTask = new Map(items.map((item) => [item.taskSessionId, item]));
  return [...byTask.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 20);
}

function normalizeSnapshot(value: unknown, now: number): ProjectSnapshot {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
  return {
    projectSummary: normalizeString(record.projectSummary, 4_000),
    projectSummarySource: record.projectSummarySource === "generated" ? "generated" : "manual",
    techStack: normalizeTechStack(record.techStack, now),
    currentGoals: normalizeStringArray(record.currentGoals),
    recentChanges: normalizeRecentChanges(record.recentChanges, now),
    pendingItems: normalizePendingItems(record.pendingItems, now),
    confirmedRisks: normalizeStringArray(record.confirmedRisks)
  };
}

function stableMigrationId(content: string) {
  return `migrated-convention-${crypto.createHash("sha256").update(content.toLocaleLowerCase()).digest("hex").slice(0, 16)}`;
}

function normalizeScope(value: unknown): ProjectMemoryScope {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
  const paths = normalizeStringArray(record.paths, 30, 500);
  return record.type === "path" && paths.length ? { type: "path", paths } : { type: "project", paths: [] };
}

function normalizeSourceRefs(value: unknown): ProjectMemorySourceRef[] {
  const validTypes = new Set<ProjectMemorySourceRef["type"]>(["schema_migration", "task", "user", "file", "symbol", "dependency", "git_commit", "branch"]);
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as UnknownRecord;
    const type = validTypes.has(record.type as ProjectMemorySourceRef["type"]) ? record.type as ProjectMemorySourceRef["type"] : null;
    const refValue = normalizeString(record.value, 500);
    const contentHash = normalizeString(record.contentHash, 128);
    const filePath = normalizeString(record.filePath, 500);
    return type && refValue ? [{ type, value: refValue, ...(contentHash ? { contentHash } : {}), ...(filePath ? { filePath } : {}) }] : [];
  }).slice(0, 20);
}

function normalizeMemoryItems(value: unknown, now: number): ProjectMemoryItem[] {
  const validKinds = new Set<ProjectMemoryKind>(["convention", "decision", "fact", "risk"]);
  const validStatuses = new Set<ProjectMemoryStatus>(["candidate", "active", "stale", "rejected", "superseded", "archived"]);
  const validValidationStatuses = new Set<ProjectMemoryValidationStatus>(["unverified", "valid", "possibly_stale", "invalid", "superseded", "archived"]);
  const validCreators = new Set<ProjectMemoryCreatedBy>(["migration", "user", "system"]);
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as UnknownRecord;
    const content = normalizeString(record.content, 2_000);
    if (!content) return [];
    const createdAt = normalizeTimestamp(record.createdAt, now);
    return [{
      id: normalizeString(record.id, 200) || stableMigrationId(content),
      kind: validKinds.has(record.kind as ProjectMemoryKind) ? record.kind as ProjectMemoryKind : "fact" as const,
      content,
      status: validStatuses.has(record.status as ProjectMemoryStatus) ? record.status as ProjectMemoryStatus : "candidate" as const,
      scope: normalizeScope(record.scope),
      sourceRefs: normalizeSourceRefs(record.sourceRefs),
      createdBy: validCreators.has(record.createdBy as ProjectMemoryCreatedBy) ? record.createdBy as ProjectMemoryCreatedBy : "system" as const,
      confidence: typeof record.confidence === "number" && Number.isFinite(record.confidence) ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
      createdAt,
      updatedAt: normalizeTimestamp(record.updatedAt, createdAt),
      ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: normalizeTimestamp(record.lastUsedAt, createdAt) }),
      ...(record.lastValidatedAt === undefined ? {} : { lastValidatedAt: normalizeTimestamp(record.lastValidatedAt, createdAt) }),
      validationStatus: validValidationStatuses.has(record.validationStatus as ProjectMemoryValidationStatus)
        ? record.validationStatus as ProjectMemoryValidationStatus
        : "unverified" as const,
      ...(record.expiresAt === undefined ? {} : { expiresAt: normalizeTimestamp(record.expiresAt, createdAt) }),
      ...(normalizeString(record.supersededBy, 200) ? { supersededBy: normalizeString(record.supersededBy, 200) } : {})
    }];
  });
  // 内容、类型和作用域相同的原子记忆只保留较新的记录。
  const deduplicated = new Map<string, ProjectMemoryItem>();
  normalized.forEach((item) => {
    const key = JSON.stringify([item.kind, item.content.toLocaleLowerCase(), item.scope]);
    const current = deduplicated.get(key);
    if (!current || item.updatedAt > current.updatedAt) deduplicated.set(key, item);
  });
  return [...deduplicated.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 200);
}

function migrateLegacyMemory(record: UnknownRecord, version: 1 | 2, now: number): ProjectMemory {
  const createdAt = normalizeTimestamp(record.createdAt, now);
  const conventions = normalizeStringArray(record.conventions);
  const migratedItems = conventions.map((content): ProjectMemoryItem => ({
    id: stableMigrationId(content),
    kind: "convention",
    content,
    // 历史约定不得自动提升为可信规则，必须等待用户确认。
    status: "candidate",
    scope: { type: "project", paths: [] },
    sourceRefs: [{ type: "schema_migration", value: `project-memory-v${version}:conventions` }],
    createdBy: "migration",
    confidence: 0.5,
    createdAt,
    updatedAt: normalizeTimestamp(record.updatedAt, createdAt),
    validationStatus: "unverified"
  }));
  return normalizeProjectMemoryV3({
    schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
    snapshot: record,
    items: migratedItems,
    createdAt,
    updatedAt: normalizeTimestamp(record.updatedAt, createdAt)
  }, now);
}

function normalizeProjectMemoryV3(record: UnknownRecord, now = Date.now()): ProjectMemory {
  const createdAt = normalizeTimestamp(record.createdAt, now);
  return {
    schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
    snapshot: normalizeSnapshot(record.snapshot, now),
    items: normalizeMemoryItems(record.items, now),
    createdAt,
    updatedAt: normalizeTimestamp(record.updatedAt, createdAt)
  };
}

/** 将磁盘中的 V1/V2/V3 数据统一转换为 V3；未知版本直接失败，防止误覆盖未来格式。 */
export function migrateProjectMemory(value: unknown): ProjectMemory {
  const record = asRecord(value);
  const version = record.schemaVersion;
  if (version === PROJECT_MEMORY_SCHEMA_VERSION) return normalizeProjectMemoryV3(record);
  if (version === 1 || version === 2 || version === undefined) return migrateLegacyMemory(record, version === 2 ? 2 : 1, Date.now());
  throw new Error(`Unsupported project memory schema version: ${String(version)}`);
}

export function normalizeProjectMemory(value: unknown): ProjectMemory {
  const record = asRecord(value);
  return record.schemaVersion === PROJECT_MEMORY_SCHEMA_VERSION ? normalizeProjectMemoryV3(record) : migrateProjectMemory(record);
}
