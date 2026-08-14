import fs from "node:fs/promises";
import path from "node:path";
import { appStatePath } from "../../statePaths.js";

export type ShadowComparisonDimension = "outcome" | "result_status" | "route";

export type ShadowResultDescriptor = Partial<Record<ShadowComparisonDimension, string>>;

export type ShadowComparison = {
  comparedDimensions: number;
  differingDimensions: ShadowComparisonDimension[];
  equivalent: boolean;
};

export type ShadowDurationBucket = "lt_100ms" | "lt_500ms" | "lt_2s" | "lt_10s" | "gte_10s";

export type ShadowComparisonMetric = {
  schemaVersion: 1;
  recordedAt: string;
  mode: "shadow";
  selected: "legacy";
  legacyStatus: "completed" | "failed";
  nextStatus: "completed" | "failed";
  legacyDuration: ShadowDurationBucket;
  nextDuration: ShadowDurationBucket;
  comparison?: ShadowComparison;
};

const DIMENSIONS: readonly ShadowComparisonDimension[] = ["outcome", "result_status", "route"];
const metricWriteQueues = new Map<string, Promise<void>>();

/**
 * 仅比较固定维度并输出“哪个维度不同”，绝不复制模型回答、Prompt、源码或错误正文。
 * 描述器即使意外返回敏感值，最终记录也只保留布尔差异。
 */
export function compareShadowResults(
  legacy: ShadowResultDescriptor,
  next: ShadowResultDescriptor
): ShadowComparison {
  const comparable = DIMENSIONS.filter((dimension) => legacy[dimension] !== undefined && next[dimension] !== undefined);
  const differingDimensions = comparable.filter((dimension) => legacy[dimension] !== next[dimension]);
  return {
    comparedDimensions: comparable.length,
    differingDimensions,
    equivalent: comparable.length > 0 && differingDimensions.length === 0
  };
}

/** 使用固定区间记录耗时，避免高精度时序数据成为请求侧信道。 */
export function shadowDurationBucket(durationMs: number): ShadowDurationBucket {
  if (durationMs < 100) return "lt_100ms";
  if (durationMs < 500) return "lt_500ms";
  if (durationMs < 2_000) return "lt_2s";
  if (durationMs < 10_000) return "lt_10s";
  return "gte_10s";
}

/**
 * Shadow 指标独立于业务状态保存；写入失败由调用方隔离，不能改变用户结果。
 * 使用串行队列避免并发请求互相覆盖 JSONL 记录。
 */
export async function appendShadowComparisonMetric(
  metric: ShadowComparisonMetric,
  filePath = appStatePath("langgraph-shadow-comparisons.jsonl")
): Promise<void> {
  const key = path.resolve(filePath);
  const previous = metricWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const temporaryPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      // 通过临时文件替换保证进程中断时不会留下半行 JSON 指标。
      await fs.writeFile(temporaryPath, `${existing}${JSON.stringify(metric)}\n`, "utf8");
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
  metricWriteQueues.set(key, next);
  try {
    await next;
  } finally {
    if (metricWriteQueues.get(key) === next) metricWriteQueues.delete(key);
  }
}
