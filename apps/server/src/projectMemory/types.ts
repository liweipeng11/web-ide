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
export type ProjectMemoryStatus = "candidate" | "active" | "stale" | "rejected" | "superseded" | "archived";
export type ProjectMemoryCreatedBy = "migration" | "user" | "system";
export type ProjectMemoryValidationStatus = "unverified" | "valid" | "possibly_stale" | "invalid" | "superseded" | "archived";

export type ProjectMemoryScope = {
  type: "project" | "path";
  paths: string[];
};

export type ProjectMemorySourceRef = {
  type: "schema_migration" | "task" | "user" | "file" | "symbol" | "dependency" | "git_commit" | "branch";
  value: string;
  /** 文件来源可携带采集时的 SHA-256；符号来源可指明所属文件。 */
  contentHash?: string;
  filePath?: string;
};

export type CreateMemoryCandidateInput = {
  kind: ProjectMemoryKind;
  content: string;
  scope?: ProjectMemoryScope;
  sourceRefs: ProjectMemorySourceRef[];
  createdBy: ProjectMemoryCreatedBy;
  confidence: number;
};

// 用户只能修订候选的业务内容，来源、创建者和时间等审计字段由服务端维护。
export type UpdateMemoryCandidateInput = Partial<Pick<ProjectMemoryItem, "kind" | "content" | "scope">>;

export type MemoryExtractionResult = {
  candidates: Array<{
    kind: ProjectMemoryKind;
    content: string;
    confidence: number;
    sourceRefs: ProjectMemorySourceRef[];
  }>;
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
  lastUsedAt?: number;
  lastValidatedAt?: number;
  validationStatus: ProjectMemoryValidationStatus;
  expiresAt?: number;
  supersededBy?: string;
};

export type ProjectMemory = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION;
  snapshot: ProjectSnapshot;
  items: ProjectMemoryItem[];
  createdAt: number;
  updatedAt: number;
};

/** 当前模型调用的召回线索；调用方只提供已知信息，召回层负责统一默认值。 */
export type MemoryRetrievalContext = {
  userRequest: string;
  contextPaths: string[];
  plannedFiles: string[];
  languages: string[];
  frameworks: string[];
  branch?: string;
  maxItems: number;
  tokenBudget: number;
};

export type ScoredProjectMemoryItem = {
  item: ProjectMemoryItem;
  score: number;
  reasons: string[];
};

/** 保留选择原因和预算数据，便于测试、日志与后续管理界面追踪召回。 */
export type ProjectMemoryRetrievalResult = {
  prompt: string;
  selectedItems: ScoredProjectMemoryItem[];
  estimatedTokens: number;
  tokenBudget: number;
  snapshotTokenBudget: number;
  memoryTokenBudget: number;
};

// 自动扫描与任务事实字段不接受外部覆盖，避免客户端伪造当前工作区状态。
export type UpdateProjectMemoryInput = Partial<Pick<ProjectSnapshot, "projectSummary" | "currentGoals" | "confirmedRisks">>;
