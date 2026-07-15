export type ContextBudgetSnapshot = {
  modelContextWindowTokens: number;
  reservedOutputTokens: number;
  reservedToolSchemaTokens: number;
  safetyMarginTokens: number;
  estimatedInputTokensBeforeCompression: number;
  estimatedInputTokensAfterCompression: number;
  compressionCount: number;
  truncatedArtifactCount: number;
  estimator: "provider" | "conservative" | "unknown";
};

