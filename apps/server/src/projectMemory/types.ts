import type { TaskSessionStatus } from "../types.js";

export const PROJECT_MEMORY_SCHEMA_VERSION = 2;

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

export type ProjectMemory = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION;
  projectSummary: string;
  projectSummarySource: ProjectSummarySource;
  techStack: ProjectMemoryTechStack;
  conventions: string[];
  currentGoals: string[];
  recentChanges: ProjectMemoryRecentChange[];
  pendingItems: ProjectMemoryPendingItem[];
  confirmedRisks: string[];
  createdAt: number;
  updatedAt: number;
};

// 自动汇总字段不接受外部直接覆盖，避免任务事实被手工请求伪造。
export type UpdateProjectMemoryInput = Partial<Pick<ProjectMemory, "projectSummary" | "conventions" | "currentGoals" | "confirmedRisks">>;
