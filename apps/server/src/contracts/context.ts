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
  filesRead: string[];
  filesModified: string[];
  commands: Array<{ command: string; status: "success" | "failed"; exitCode: number | null }>;
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
};
