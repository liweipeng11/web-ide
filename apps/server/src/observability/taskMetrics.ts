import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appStatePath } from "../statePaths.js";
import { appendRunMetrics, type RunFinalStatus, type RunMetrics, type RunMetricsRecorder } from "./runMetrics.js";

const taskMetrics = new Map<string, RunMetrics>();
const taskMetricQueues = new Map<string, Promise<unknown>>();
const pendingFinalizers = new Map<string, ReturnType<typeof setTimeout>>();

function correlationId(metrics: RunMetrics) {
  return metrics.taskSessionId || metrics.runId;
}

function snapshotDirectory() {
  return appStatePath("task-metrics");
}

function snapshotPath(key: string) {
  // 使用摘要作为文件名，避免任务 ID 中的路径字符越过状态目录边界。
  return path.join(snapshotDirectory(), `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
}

async function readSnapshot(key: string) {
  const content = await fs.readFile(snapshotPath(key), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!content) return null;

  try {
    const metrics = JSON.parse(content) as RunMetrics;
    if (metrics?.schemaVersion !== 1 || metrics.scope !== "task_run") return null;
    // 兼容首 token 来源字段加入前生成的阶段 0 快照。
    metrics.firstTokenLatencySource ??= metrics.firstTokenLatencyMs === null ? "unavailable" : "completion_upper_bound";
    return metrics;
  } catch {
    return null;
  }
}

async function writeSnapshot(key: string, metrics: RunMetrics) {
  // 没有关联任务会话的临时运行只在进程内聚合，避免生成无法终态清理的孤儿快照。
  if (!metrics.taskSessionId) return;
  const directory = snapshotDirectory();
  const targetPath = snapshotPath(key);
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporaryPath, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, targetPath);
}

async function deleteSnapshot(key: string) {
  await fs.rm(snapshotPath(key), { force: true });
}

async function enqueueTaskMetricUpdate<T>(key: string, update: () => Promise<T>) {
  const previous = taskMetricQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(update);
  taskMetricQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (taskMetricQueues.get(key) === next) taskMetricQueues.delete(key);
  }
}

async function loadTaskMetrics(key: string) {
  const cached = taskMetrics.get(key);
  if (cached) return cached;
  const persisted = await readSnapshot(key);
  if (persisted) taskMetrics.set(key, persisted);
  return persisted;
}

function createTaskMetrics(metrics: RunMetrics): RunMetrics {
  return {
    ...structuredClone(metrics),
    scope: "task_run",
    runId: metrics.taskSessionId ? `task:${metrics.taskSessionId}` : metrics.runId,
    mode: "task"
  };
}

function mergeFirstTokenLatency(current: RunMetrics, metrics: RunMetrics) {
  if (metrics.firstTokenLatencyMs === null) return;
  const shouldReplace =
    current.firstTokenLatencyMs === null
    || (metrics.firstTokenLatencySource === "provider" && current.firstTokenLatencySource !== "provider")
    || (metrics.firstTokenLatencySource === current.firstTokenLatencySource && metrics.firstTokenLatencyMs < current.firstTokenLatencyMs);
  if (shouldReplace) {
    current.firstTokenLatencyMs = metrics.firstTokenLatencyMs;
    current.firstTokenLatencySource = metrics.firstTokenLatencySource;
  }
}

// 合并审批前后模型片段和验证片段，并持久化快照以支持服务重启后继续累计。
export async function mergeTaskMetrics(metrics: RunMetrics) {
  if (metrics.scope === "task_run") return metrics;
  const key = correlationId(metrics);
  return enqueueTaskMetricUpdate(key, async () => {
    const current = await loadTaskMetrics(key);
    if (!current) {
      const created = createTaskMetrics(metrics);
      taskMetrics.set(key, created);
      await writeSnapshot(key, created);
      return structuredClone(created);
    }

    current.finishedAt = metrics.finishedAt;
    current.durationMs = Math.max(0, Date.parse(metrics.finishedAt) - Date.parse(current.startedAt));
    mergeFirstTokenLatency(current, metrics);
    current.usage.inputTokens += metrics.usage.inputTokens;
    current.usage.outputTokens += metrics.usage.outputTokens;
    current.usage.reasoningTokens += metrics.usage.reasoningTokens;
    current.usage.cachedInputTokens += metrics.usage.cachedInputTokens;
    current.tools.calls += metrics.tools.calls;
    current.tools.repeatedCalls += metrics.tools.repeatedCalls;
    current.tools.failedCalls += metrics.tools.failedCalls;
    current.context.compressionCount += metrics.context.compressionCount;
    current.context.estimatedTokensBefore = Math.max(current.context.estimatedTokensBefore ?? 0, metrics.context.estimatedTokensBefore ?? 0) || null;
    current.context.estimatedTokensAfter = metrics.context.estimatedTokensAfter ?? current.context.estimatedTokensAfter;
    if (metrics.context.estimator !== "unavailable") current.context.estimator = metrics.context.estimator;
    current.result.status = metrics.result.status;
    if (metrics.result.failureCategory !== "none") current.result.failureCategory = metrics.result.failureCategory;
    current.result.patchFileCount = Math.max(current.result.patchFileCount, metrics.result.patchFileCount);
    current.result.validationCommandCount += metrics.result.validationCommandCount;
    if (metrics.result.validationStatus !== "not_run") current.result.validationStatus = metrics.result.validationStatus;
    taskMetrics.set(key, current);
    await writeSnapshot(key, current);
    return structuredClone(current);
  });
}

export async function recordTaskPatchMetrics(key: string | null | undefined, patchFileCount: number) {
  if (!key) return null;
  return enqueueTaskMetricUpdate(key, async () => {
    const current = await loadTaskMetrics(key);
    if (!current) return null;
    current.result.patchFileCount = Math.max(current.result.patchFileCount, patchFileCount);
    await writeSnapshot(key, current);
    return structuredClone(current);
  });
}

export async function getTaskMetricsSnapshot(key: string) {
  const metrics = await enqueueTaskMetricUpdate(key, () => loadTaskMetrics(key));
  return metrics ? structuredClone(metrics) : null;
}

export async function finalizeTaskMetrics(key: string | null | undefined, status: RunFinalStatus, recorder: RunMetricsRecorder = appendRunMetrics) {
  if (!key) return null;
  return enqueueTaskMetricUpdate(key, async () => {
    const current = await loadTaskMetrics(key);
    if (!current) return null;
    current.finishedAt = new Date().toISOString();
    current.durationMs = Math.max(0, Date.parse(current.finishedAt) - Date.parse(current.startedAt));
    current.result.status = status;
    if (status === "completed") current.result.failureCategory = "none";
    if (status === "cancelled") current.result.failureCategory = "cancelled";
    if (status === "failed" && current.result.failureCategory === "none") current.result.failureCategory = "internal_error";
    try {
      await recorder(current);
    } catch (error) {
      console.warn("[metrics] failed to persist task metrics", error instanceof Error ? error.message : "unknown error");
    } finally {
      taskMetrics.delete(key);
      await deleteSnapshot(key);
    }
    return structuredClone(current);
  });
}

export function scheduleTaskMetricsFinalization(key: string | null | undefined, status: RunFinalStatus) {
  if (!key) return;
  const pending = pendingFinalizers.get(key);
  if (pending) clearTimeout(pending);

  // 终态可能先于验证指标写入；延迟到当前异步链结束后再汇总落盘。
  const timer = setTimeout(() => {
    pendingFinalizers.delete(key);
    void finalizeTaskMetrics(key, status);
  }, 0);
  timer.unref?.();
  pendingFinalizers.set(key, timer);
}

export async function clearTaskMetricsForTest(options: { key?: string; memoryOnly?: boolean } = {}) {
  for (const timer of pendingFinalizers.values()) clearTimeout(timer);
  pendingFinalizers.clear();
  taskMetrics.clear();
  taskMetricQueues.clear();
  if (options.memoryOnly) return;
  if (options.key) await deleteSnapshot(options.key);
  else await fs.rm(snapshotDirectory(), { recursive: true, force: true });
}
