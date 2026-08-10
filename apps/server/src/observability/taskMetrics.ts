import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { appStatePath } from "../statePaths.js";
import { readJsonStateFile, writeJsonStateFile } from "../stateFileStorage.js";
import { appendRunMetrics, COMPLETION_RESOURCE_LIMITS, createEmptyProgressiveDeliveryMetrics, createEmptySubagentMetrics, createEmptyTaskSessionPersistenceMetrics, type ProgressiveDeliveryMetrics, type RunFinalStatus, type RunMetrics, type RunMetricsRecorder, type SafeEditorMetricDelta, type SubagentMetrics, type TaskSessionPersistenceMetrics } from "./runMetrics.js";

const taskMetrics = new Map<string, RunMetrics>();
const taskMetricQueues = new Map<string, Promise<unknown>>();
const pendingFinalizers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingTaskSessionPersistenceMetrics = new Map<string, TaskSessionPersistenceMetrics>();

function addTaskSessionPersistenceMetrics(target: TaskSessionPersistenceMetrics, delta: Partial<TaskSessionPersistenceMetrics>) {
  for (const key of Object.keys(delta) as Array<keyof TaskSessionPersistenceMetrics>) {
    const value = delta[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) target[key] += Math.floor(value);
  }
}

function applyPendingTaskSessionPersistenceMetrics(key: string, metrics: RunMetrics) {
  const pending = pendingTaskSessionPersistenceMetrics.get(key);
  if (!pending) return;
  addTaskSessionPersistenceMetrics(metrics.taskSessionPersistence, pending);
  pendingTaskSessionPersistenceMetrics.delete(key);
}

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

function normalizeMetricFields(metrics: RunMetrics) {
  // 阶段 1 之前的持久化快照没有诊断字段，读取时补零以保持向后兼容。
  metrics.tools.cacheHits ??= 0;
  metrics.tools.emptyResults ??= 0;
  metrics.tools.invalidToolCalls ??= 0;
  metrics.tools.consecutiveNoProgressSteps ??= 0;
  metrics.tools.maxConsecutiveNoProgressSteps ??= 0;
  metrics.tools.mostRepeatedCall ??= null;
  metrics.safeEditorNeedsAnalysisCount ??= 0;
  metrics.safeEditorAutoAnalysisAttemptCount ??= 0;
  metrics.safeEditorAutoAnalysisSuccessCount ??= 0;
  metrics.safeEditorConfirmedExpansionCount ??= 0;
  metrics.safeEditorRiskAcknowledgementCount ??= 0;
  metrics.safeEditorFalseExpansionRegressionCount ??= 0;
  metrics.completionRequestCount ??= 0;
  metrics.completionAcceptedCount ??= 0;
  metrics.completionRejectedCount ??= 0;
  metrics.sameEvidenceRejectionCount ??= 0;
  metrics.approvalResumeCount ??= 0;
  metrics.mutationEvidenceRestoreFailureCount ??= 0;
  metrics.completionLoopStoppedCount ??= 0;
  metrics.providerCallCount ??= 0;
  metrics.providerCallsAfterFirstCompletionRejection ??= 0;
  metrics.changedFileCount ??= 0;
  metrics.inputTokensPerChangedFile ??= null;
  metrics.contextCompressionCount ??= metrics.context?.compressionCount ?? 0;
  metrics.completionResourceAlerts ??= [];
  metrics.completionRejections ??= [];
  metrics.taskSessionPersistence ??= createEmptyTaskSessionPersistenceMetrics();
  metrics.taskSessionPersistence.taskSessionUpdateCount ??= 0;
  metrics.taskSessionPersistence.taskSessionPhysicalWriteCount ??= 0;
  metrics.taskSessionPersistence.taskSessionWriteSkippedCount ??= 0;
  metrics.taskSessionPersistence.taskSessionWriteCoalescedCount ??= 0;
  metrics.taskSessionPersistence.taskSessionRenameRetryCount ??= 0;
  metrics.progressiveDelivery ??= createEmptyProgressiveDeliveryMetrics();
  metrics.progressiveDelivery.deliveryUnits ??= createEmptyProgressiveDeliveryMetrics().deliveryUnits;
  metrics.progressiveDelivery.toolFailuresByCategory ??= {};
  metrics.progressiveDelivery.recoveryDecisions ??= { total: 0, byAction: {} };
  metrics.progressiveDelivery.recoveryDecisions.byAction ??= {};
  metrics.progressiveDelivery.noProgressTransitions ??= { replan: 0, awaitingUser: 0, successfulDelivery: 0 };
  metrics.progressiveDelivery.unitSummaries ??= [];
  // 阶段 1：子代理指标默认值兼容，保证阶段 0 快照在阶段 1 读取时不会解构 undefined。
  metrics.subagentMetrics ??= createEmptySubagentMetrics();
  metrics.subagentMetrics.byArtifactsKind ??= { analysis: 0, proposed_patch: 0, execution_report: 0, modification_plan: 0 };
  metrics.subagentMetrics.byKind ??= { analysis: 0, implementation: 0, verification: 0, planning: 0 };
  metrics.subagentMetrics.byStatus ??= { succeeded: 0, failed: 0, cancelled: 0 };
  // 阶段 6：并行指标默认值兼容。
  metrics.subagentMetrics.concurrent ??= { batches: 0, totalParallelTasks: 0, peakConcurrency: 0, totalParallelDurationMs: 0 };
  metrics.result.stopReason ??= metrics.result.status === "completed"
    ? "completed"
    : metrics.result.status === "awaiting_approval"
      ? "awaiting_approval"
      : metrics.result.status === "incomplete"
        ? "incomplete"
        : metrics.result.status === "blocked"
          ? "blocked"
      : metrics.result.status === "cancelled"
        ? "cancelled"
        : metrics.result.status === "step_limit_reached"
          ? "step_limit"
          : "provider_error";
  return metrics;
}

/** 合并影子指标时只累加计数，单元摘要按稳定 ID 覆盖为最新状态。 */
function mergeProgressiveDeliveryMetrics(current: ProgressiveDeliveryMetrics, next: ProgressiveDeliveryMetrics) {
  current.deliveryUnits = { ...next.deliveryUnits };
  for (const [category, count] of Object.entries(next.toolFailuresByCategory)) {
    current.toolFailuresByCategory[category] = (current.toolFailuresByCategory[category] ?? 0) + count;
  }
  current.recoveryDecisions.total += next.recoveryDecisions.total;
  for (const [action, count] of Object.entries(next.recoveryDecisions.byAction)) {
    current.recoveryDecisions.byAction[action] = (current.recoveryDecisions.byAction[action] ?? 0) + count;
  }
  current.noProgressTransitions.replan += next.noProgressTransitions.replan;
  current.noProgressTransitions.awaitingUser += next.noProgressTransitions.awaitingUser;
  current.noProgressTransitions.successfulDelivery += next.noProgressTransitions.successfulDelivery;
  const summaries = new Map(current.unitSummaries.map((unit) => [unit.unitId, unit]));
  for (const summary of next.unitSummaries) summaries.set(summary.unitId, structuredClone(summary));
  current.unitSummaries = [...summaries.values()].slice(0, 100);
}

// 阶段 1：累加子代理跨运行指标，区分父代理和子代理的失败归属。
function mergeSubagentMetrics(current: SubagentMetrics, next: SubagentMetrics) {
  current.totalRuns += next.totalRuns;
  current.freshStarted += next.freshStarted;
  current.byStatus.succeeded += next.byStatus.succeeded;
  current.byStatus.failed += next.byStatus.failed;
  current.byStatus.cancelled += next.byStatus.cancelled;
  for (const kind of Object.keys(next.byKind) as Array<keyof SubagentMetrics["byKind"]>) {
    current.byKind[kind] += next.byKind[kind];
  }
  for (const kind of Object.keys(next.byArtifactsKind) as Array<keyof SubagentMetrics["byArtifactsKind"]>) {
    current.byArtifactsKind[kind] += next.byArtifactsKind[kind];
  }
  // 阶段 6：并行统计累加。
  current.concurrent.batches += next.concurrent.batches;
  current.concurrent.totalParallelTasks += next.concurrent.totalParallelTasks;
  current.concurrent.peakConcurrency = Math.max(current.concurrent.peakConcurrency, next.concurrent.peakConcurrency);
  current.concurrent.totalParallelDurationMs += next.concurrent.totalParallelDurationMs;
}

function refreshCompletionResourceAlerts(metrics: RunMetrics) {
  const alerts = new Set(metrics.completionResourceAlerts);
  if (metrics.inputTokensPerChangedFile !== null && metrics.inputTokensPerChangedFile > COMPLETION_RESOURCE_LIMITS.maxInputTokensPerChangedFile) {
    alerts.add("HIGH_INPUT_TOKENS_PER_CHANGED_FILE");
  }
  if (metrics.contextCompressionCount > COMPLETION_RESOURCE_LIMITS.maxContextCompressionCount) {
    alerts.add("EXCESSIVE_CONTEXT_COMPRESSION");
  }
  if (metrics.providerCallsAfterFirstCompletionRejection > COMPLETION_RESOURCE_LIMITS.maxProviderCallsAfterFirstCompletionRejection) {
    alerts.add("EXCESSIVE_PROVIDER_CALLS_AFTER_REJECTION");
  }
  metrics.completionResourceAlerts = [...alerts];
}

async function readSnapshot(key: string) {
  const metrics = await readJsonStateFile<RunMetrics>(snapshotPath(key), {
    allowMissing: true,
    recover: true,
    validate(value) {
      const candidate = value as Partial<RunMetrics> | null;
      if (!candidate || candidate.schemaVersion !== 1 || candidate.scope !== "task_run") {
        throw new Error("unsupported task metrics snapshot");
      }
      return candidate as RunMetrics;
    }
  });
  if (!metrics) return null;
  // 兼容首 token 来源字段加入前生成的阶段 0 快照。
  metrics.firstTokenLatencySource ??= metrics.firstTokenLatencyMs === null ? "unavailable" : "completion_upper_bound";
  return normalizeMetricFields(metrics);
}

async function writeSnapshot(key: string, metrics: RunMetrics) {
  // 没有关联任务会话的临时运行只在进程内聚合，避免生成无法终态清理的孤儿快照。
  if (!metrics.taskSessionId) return;
  const directory = snapshotDirectory();
  const targetPath = snapshotPath(key);
  await fs.mkdir(directory, { recursive: true });
  await writeJsonStateFile(targetPath, metrics);
}

async function deleteSnapshot(key: string) {
  await Promise.all([
    fs.rm(snapshotPath(key), { force: true }),
    fs.rm(`${snapshotPath(key)}.bak`, { force: true })
  ]);
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
  if (cached) {
    applyPendingTaskSessionPersistenceMetrics(key, cached);
    return cached;
  }
  const persisted = await readSnapshot(key);
  if (persisted) {
    applyPendingTaskSessionPersistenceMetrics(key, persisted);
    taskMetrics.set(key, persisted);
  }
  return persisted;
}

function createTaskMetrics(metrics: RunMetrics): RunMetrics {
  const created: RunMetrics = {
    ...structuredClone(metrics),
    scope: "task_run",
    runId: metrics.taskSessionId ? `task:${metrics.taskSessionId}` : metrics.runId,
    mode: "task"
  };
  created.taskSessionPersistence = createEmptyTaskSessionPersistenceMetrics();
  applyPendingTaskSessionPersistenceMetrics(correlationId(metrics), created);
  return created;
}

/**
 * 记录任务会话存储层的逻辑更新与物理写入差异。
 * 指标先在内存聚合，避免为了记录“减少写入”反而制造新的高频指标落盘。
 */
export function recordTaskSessionPersistenceMetrics(key: string | null | undefined, delta: Partial<TaskSessionPersistenceMetrics>) {
  if (!key) return;
  const current = taskMetrics.get(key);
  if (current) {
    addTaskSessionPersistenceMetrics(current.taskSessionPersistence, delta);
    return;
  }
  const pending = pendingTaskSessionPersistenceMetrics.get(key) ?? createEmptyTaskSessionPersistenceMetrics();
  addTaskSessionPersistenceMetrics(pending, delta);
  pendingTaskSessionPersistenceMetrics.set(key, pending);
}

export async function getTaskSessionPersistenceMetrics(key: string) {
  const current = await enqueueTaskMetricUpdate(key, () => loadTaskMetrics(key));
  if (current) return structuredClone(current.taskSessionPersistence);
  return structuredClone(pendingTaskSessionPersistenceMetrics.get(key) ?? createEmptyTaskSessionPersistenceMetrics());
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
    // 本地验证没有模型费用，不能把已知的模型费用污染成“无法估算”。
    if (!(metrics.scope === "validation_run" && metrics.estimatedCostUsd === null)) {
      current.estimatedCostUsd = current.estimatedCostUsd === null || metrics.estimatedCostUsd === null
        ? null
        // 费用跨多次模型调用累加时统一保留 12 位小数，避免浮点尾差泄漏到 API。
        : Math.round((current.estimatedCostUsd + metrics.estimatedCostUsd) * 1_000_000_000_000) / 1_000_000_000_000;
    }
    current.safeEditorNeedsAnalysisCount += metrics.safeEditorNeedsAnalysisCount;
    current.safeEditorAutoAnalysisAttemptCount += metrics.safeEditorAutoAnalysisAttemptCount;
    current.safeEditorAutoAnalysisSuccessCount += metrics.safeEditorAutoAnalysisSuccessCount;
    current.safeEditorConfirmedExpansionCount += metrics.safeEditorConfirmedExpansionCount;
    current.safeEditorRiskAcknowledgementCount += metrics.safeEditorRiskAcknowledgementCount;
    current.safeEditorFalseExpansionRegressionCount += metrics.safeEditorFalseExpansionRegressionCount;
    const taskAlreadyRejectedCompletion = current.completionRejectedCount > 0;
    const previousApprovalResumeCount = current.approvalResumeCount;
    current.completionRequestCount += metrics.completionRequestCount;
    current.completionAcceptedCount += metrics.completionAcceptedCount;
    current.completionRejectedCount += metrics.completionRejectedCount;
    current.sameEvidenceRejectionCount += metrics.sameEvidenceRejectionCount;
    current.approvalResumeCount += metrics.approvalResumeCount;
    current.mutationEvidenceRestoreFailureCount += metrics.mutationEvidenceRestoreFailureCount;
    current.completionLoopStoppedCount += metrics.completionLoopStoppedCount;
    current.providerCallCount += metrics.providerCallCount;
    current.providerCallsAfterFirstCompletionRejection += taskAlreadyRejectedCompletion
      ? metrics.providerCallCount
      : metrics.providerCallsAfterFirstCompletionRejection;
    current.changedFileCount = Math.max(current.changedFileCount, metrics.changedFileCount);
    current.inputTokensPerChangedFile = current.changedFileCount > 0
      ? Math.round((current.usage.inputTokens / current.changedFileCount) * 100) / 100
      : null;
    current.completionResourceAlerts = [...new Set([
      ...current.completionResourceAlerts,
      ...metrics.completionResourceAlerts
    ])];
    current.completionRejections = [
      ...current.completionRejections,
      ...metrics.completionRejections.map((diagnostic) => ({
        ...diagnostic,
        resumeCount: previousApprovalResumeCount + diagnostic.resumeCount
      }))
    ].slice(-20);
    current.tools.calls += metrics.tools.calls;
    current.tools.repeatedCalls += metrics.tools.repeatedCalls;
    current.tools.failedCalls += metrics.tools.failedCalls;
    current.tools.cacheHits += metrics.tools.cacheHits;
    current.tools.emptyResults += metrics.tools.emptyResults;
    current.tools.invalidToolCalls += metrics.tools.invalidToolCalls;
    current.tools.consecutiveNoProgressSteps = metrics.tools.consecutiveNoProgressSteps;
    current.tools.maxConsecutiveNoProgressSteps = Math.max(current.tools.maxConsecutiveNoProgressSteps, metrics.tools.maxConsecutiveNoProgressSteps);
    if (
      metrics.tools.mostRepeatedCall
      && (!current.tools.mostRepeatedCall || metrics.tools.mostRepeatedCall.repeatedCalls > current.tools.mostRepeatedCall.repeatedCalls)
    ) {
      current.tools.mostRepeatedCall = structuredClone(metrics.tools.mostRepeatedCall);
    }
    current.context.compressionCount += metrics.context.compressionCount;
    current.contextCompressionCount = current.context.compressionCount;
    current.context.estimatedTokensBefore = Math.max(current.context.estimatedTokensBefore ?? 0, metrics.context.estimatedTokensBefore ?? 0) || null;
    current.context.estimatedTokensAfter = metrics.context.estimatedTokensAfter ?? current.context.estimatedTokensAfter;
    if (metrics.context.estimator !== "unavailable") current.context.estimator = metrics.context.estimator;
    mergeProgressiveDeliveryMetrics(current.progressiveDelivery, metrics.progressiveDelivery);
    if (current.subagentMetrics && metrics.subagentMetrics) {
      mergeSubagentMetrics(current.subagentMetrics, metrics.subagentMetrics);
    }
    current.result.status = metrics.result.status;
    current.result.stopReason = metrics.result.stopReason;
    if (metrics.result.failureCategory !== "none") current.result.failureCategory = metrics.result.failureCategory;
    current.result.patchFileCount = Math.max(current.result.patchFileCount, metrics.result.patchFileCount);
    current.result.validationCommandCount += metrics.result.validationCommandCount;
    if (metrics.result.validationStatus !== "not_run") current.result.validationStatus = metrics.result.validationStatus;
    // 单次运行未越界时，审批前后累计值仍可能触发任务级资源告警。
    refreshCompletionResourceAlerts(current);
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

/** 审批恢复发生在新模型运行创建前，直接把脱敏事件合并到已有任务指标。 */
export async function recordTaskSafeEditorMetrics(key: string | null | undefined, delta: SafeEditorMetricDelta) {
  if (!key) return null;
  return enqueueTaskMetricUpdate(key, async () => {
    const current = await loadTaskMetrics(key);
    if (!current) return null;
    for (const metric of Object.keys(delta) as Array<keyof SafeEditorMetricDelta>) {
      const value = delta[metric];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) current[metric] += Math.floor(value);
    }
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
    if (!current) {
      pendingTaskSessionPersistenceMetrics.delete(key);
      return null;
    }
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
      pendingTaskSessionPersistenceMetrics.delete(key);
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
  if (options.key) pendingTaskSessionPersistenceMetrics.delete(options.key);
  else pendingTaskSessionPersistenceMetrics.clear();
  if (options.memoryOnly) return;
  if (options.key) await deleteSnapshot(options.key);
  else await fs.rm(snapshotDirectory(), { recursive: true, force: true });
}
