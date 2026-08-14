export type BaselineRunResult = {
  scenarioId: string;
  outcome: "completed" | "rejected" | "failed" | "paused";
  signals: readonly string[];
  message?: string;
  metadata?: Record<string, unknown>;
};

export type NormalizedBaselineResult = {
  scenarioId: string;
  outcome: BaselineRunResult["outcome"];
  signals: string[];
  message?: string;
  metadata?: Record<string, unknown>;
};

const volatileMetadataKeys = new Set(["timestamp", "createdAt", "updatedAt", "durationMs", "requestId", "runId"]);

/**
 * 移除运行时波动字段并稳定排序，供后续 Legacy 与新路径的快照对照使用。
 * 该适配器不读取或输出源码、Prompt、凭据等敏感内容。
 */
export function normalizeBaselineResult(result: BaselineRunResult): NormalizedBaselineResult {
  return {
    scenarioId: result.scenarioId,
    outcome: result.outcome,
    signals: [...new Set(result.signals)].sort(),
    ...(result.message ? { message: result.message } : {}),
    ...(result.metadata ? { metadata: normalizeMetadata(result.metadata) } : {})
  };
}

function normalizeMetadata(metadata: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !volatileMetadataKeys.has(key))
      .sort(([left], [right]) => left.localeCompare(right))
  );
}
