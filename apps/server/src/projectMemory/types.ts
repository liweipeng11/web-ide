import type { TaskSessionStatus } from "../types.js";

export const PROJECT_MEMORY_SCHEMA_VERSION = 3;

export type ProjectSummarySource = "generated" | "manual";

export type ProjectMemoryTechStack = {
  packageManager: string | null;
  languages: string[];
  frameworks: string[];
  buildTools: string[];
  lintTools: string[];
  typeSystems: string[];
  testTools: string[];
  workspacePackages: string[];
  scannedAt: number;
};

export type ProjectMemoryRecentChange = {
  taskSessionId: string;
  summary: string;
  files: string[];
  changedAt: number;
};

export type ProjectMemoryPendingItem = {
  taskSessionId: string;
  summary: string;
  status: TaskSessionStatus;
  updatedAt: number;
};

/** Snapshot 只描述当前项目状态，不承载必须执行的行为指令。 */
export type ProjectSnapshot = {
  projectSummary: string;
  projectSummarySource: ProjectSummarySource;
  techStack: ProjectMemoryTechStack;
  currentGoals: string[];
  recentChanges: ProjectMemoryRecentChange[];
  pendingItems: ProjectMemoryPendingItem[];
  confirmedRisks: string[];
};

export type ProjectMemoryKind = "convention" | "decision" | "fact" | "risk";
export type ProjectMemoryStatus = "candidate" | "active";
export type ProjectMemoryCreatedBy = "migration" | "user" | "system";

export type ProjectMemoryScope = {
  type: "project" | "path";
  paths: string[];
};

export type ProjectMemorySourceRef = {
  type: "schema_migration" | "task" | "user" | "file";
  value: string;
};

/** 原子记忆始终是历史事实；即使为 active，也不能替代 Project Rules。 */
export type ProjectMemoryItem = {
  id: string;
  kind: ProjectMemoryKind;
  content: string;
  status: ProjectMemoryStatus;
  scope: ProjectMemoryScope;
  sourceRefs: ProjectMemorySourceRef[];
  createdBy: ProjectMemoryCreatedBy;
  confidence: number;
  createdAt: number;
  updatedAt: number;
};

export type ProjectMemory = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION;
  snapshot: ProjectSnapshot;
  items: ProjectMemoryItem[];
  createdAt: number;
  updatedAt: number;
};

// 自动扫描与任务事实字段不接受外部覆盖，避免客户端伪造当前工作区状态。
export type UpdateProjectMemoryInput = Partial<Pick<ProjectSnapshot, "projectSummary" | "currentGoals" | "confirmedRisks">>;
