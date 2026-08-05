export type ContextArtifactKind = "file" | "search" | "command" | "diagnostic" | "web" | "summary";

export type ContextArtifact = {
  id: string;
  kind: ContextArtifactKind;
  source: string;
  priority: number;
  estimatedTokens: number;
  content: unknown;
  truncated: boolean;
  recoverableReference?: string;
};

export type StructuredContextSummary = {
  version: 1;
  coveredMessageIds: string[];
  generatedAt: number;
  currentUserGoal: string;
  confirmedDecisions: string[];
  unresolvedQuestions: string[];
  /** 压缩后仍保留按目标记录的引用状态，避免旧缺失结论污染无关编辑。 */
  referenceChecks?: Record<string, import("../existenceChecker/types.js").ReferenceResolution>;
  filesRead: string[];
  filesModified: string[];
  commands: Array<{ command: string; status: "success" | "failed" | "running" | "cancelled"; exitCode: number | null }>;
  planStatus: string[];
  recentValidationFailures: string[];
  pendingApproval: { actionId: string; toolName: string; arguments: unknown } | null;
};

export type ContextBudgetSnapshot = {
  modelContextWindowTokens: number;
  reservedOutputTokens: number;
  reservedToolSchemaTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  estimatedInputTokensBeforeCompression: number;
  estimatedInputTokensAfterCompression: number;
  compressionCount: number;
  truncatedArtifactCount: number;
  includedFileCount: number;
  usageRatio: number;
  automaticCompression: boolean;
  generatedAt: number;
  estimator: "provider" | "conservative" | "unknown";
  /** 当前交付单元的预算归因；旧会话没有该字段时按全局预算兼容处理。 */
  deliveryUnit?: ContextBudgetUnitSnapshot;
};

/** 解释单个交付单元的上下文消耗，避免历史完整内容再次注入。 */
export type ContextBudgetUnitSnapshot = {
  deliveryUnitId?: string;
  inputTokens: number;
  currentUnitContentTokens: number;
  historicalUnitSummaryTokens: number;
  globalRuleTokens: number;
  toolResultTokens: number;
  otherTokens: number;
  toolCallCount: number;
  compressionCount: number;
  warning: boolean;
  generatedAt: number;
};
