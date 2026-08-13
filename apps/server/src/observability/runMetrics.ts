import fs from "node:fs/promises";
import path from "node:path";
import { appStatePath } from "../statePaths.js";
import type { ModelPrice, ModelUsage } from "../contracts/model.js";
import type { CompletionRejectionCode } from "../types.js";
import type { DeliveryUnit, ToolFailureDiagnostic } from "../types.js";
import type { SubagentKind, SubagentArtifactsKind } from "../agentToolTypes.js";

export const COMPLETION_RESOURCE_LIMITS = {
  maxInputTokensPerChangedFile: 100_000,
  maxContextCompressionCount: 3,
  maxProviderCallsAfterFirstCompletionRejection: 3,
  maxCompletionRejectionDiagnostics: 20
} as const;

export type CompletionResourceAlert =
  | "HIGH_INPUT_TOKENS_PER_CHANGED_FILE"
  | "EXCESSIVE_CONTEXT_COMPRESSION"
  | "EXCESSIVE_PROVIDER_CALLS_AFTER_REJECTION";

export type CompletionRejectionDiagnostic = {
  taskSessionId: string | null;
  runId: string;
  resumeCount: number;
  rejectionCode: CompletionRejectionCode;
  evidenceFingerprint: string | null;
  changedFileCount: number;
  persistedAppliedFileCount: number;
  validationStatus: RunMetrics["result"]["validationStatus"];
  lastMutationAt: number | null;
  lastValidationAt: number | null;
};

export type RunFailureCategory = "none" | "timeout" | "model_error" | "tool_error" | "validation_failure" | "cancelled" | "step_limit" | "internal_error";
export type RunFinalStatus =
  | "completed"
  | "awaiting_approval"
  | "incomplete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "step_limit_reached";
export type AgentStopReason =
  | "completed"
  | "awaiting_approval"
  | "incomplete"
  | "blocked"
  | "step_limit"
  | "repeated_tool_call"
  | "no_progress"
  | "invalid_tool_call"
  | "provider_error"
  | "cancelled";

export type MostRepeatedToolCall = {
  toolName: string;
  signature: string;
  calls: number;
  repeatedCalls: number;
  firstStep: number;
  lastStep: number;
  allResultsEmpty: boolean;
  cacheHit: boolean;
};

export type ToolRuntimeMetrics = {
  calls: number;
  repeatedCalls: number;
  cacheHits: number;
  emptyResults: number;
  invalidToolCalls: number;
  consecutiveNoProgressSteps: number;
  maxConsecutiveNoProgressSteps: number;
  recoveryAttempts: number;
  failedCalls: number;
  mostRepeatedCall: MostRepeatedToolCall | null;
};

export type TaskSessionPersistenceMetrics = {
  taskSessionUpdateCount: number;
  taskSessionPhysicalWriteCount: number;
  taskSessionWriteSkippedCount: number;
  taskSessionWriteCoalescedCount: number;
  taskSessionRenameRetryCount: number;
};

/** 阶段六只汇总交付过程的计数和状态，不保存源码、提示词或补丁内容。 */
export type ProgressiveDeliveryMetrics = {
  deliveryUnits: { total: number; completed: number; blocked: number; deferred: number };
  toolFailuresByCategory: Record<string, number>;
  recoveryDecisions: { total: number; byAction: Record<string, number> };
  noProgressTransitions: { replan: number; awaitingUser: number; successfulDelivery: number };
  unitSummaries: Array<{
    unitId: string;
    status: DeliveryUnit["status"];
    inputTokens: number;
    compressionCount: number;
    changedFileCount: number;
    validationStatus: "not_required" | "not_run" | "passed" | "failed" | "unavailable";
  }>;
};

export function createEmptyProgressiveDeliveryMetrics(): ProgressiveDeliveryMetrics {
  return {
    deliveryUnits: { total: 0, completed: 0, blocked: 0, deferred: 0 },
    toolFailuresByCategory: {},
    recoveryDecisions: { total: 0, byAction: {} },
    noProgressTransitions: { replan: 0, awaitingUser: 0, successfulDelivery: 0 },
    unitSummaries: []
  };
}

// 阶段 1：子代理运行指标，用于区分父/子代理的失败归属和产物产出维度。
export type SubagentMetrics = {
  /** 子代理运行总数（含当前运行和历史恢复）。 */
  totalRuns: number;
  /** 按产物类型统计。 */
  byArtifactsKind: Record<SubagentArtifactsKind, number>;
  /** 按子代理种类统计（analysis/implementation/verification）。 */
  byKind: Record<SubagentKind, number>;
  /** 按子代理最终状态统计。 */
  byStatus: { succeeded: number; failed: number; cancelled: number };
  /** 本次运行中新启动的子代理数（不含历史恢复）。 */
  freshStarted: number;
  // 阶段 6：并行运行统计。
  concurrent: {
    /** 并行批次总数。 */
    batches: number;
    /** 并行批次中的总任务数。 */
    totalParallelTasks: number;
    /** 并行运行时达到的最高并发数。 */
    peakConcurrency: number;
    /** 并行运行总耗时（毫秒）。 */
    totalParallelDurationMs: number;
  };
};

export function createEmptySubagentMetrics(): SubagentMetrics {
  return {
    totalRuns: 0,
    byArtifactsKind: { analysis: 0, proposed_patch: 0, execution_report: 0, modification_plan: 0 },
    byKind: { analysis: 0, implementation: 0, verification: 0, planning: 0 },
    byStatus: { succeeded: 0, failed: 0, cancelled: 0 },
    freshStarted: 0,
    concurrent: {
      batches: 0,
      totalParallelTasks: 0,
      peakConcurrency: 0,
      totalParallelDurationMs: 0
    }
  };
}

export function createEmptyTaskSessionPersistenceMetrics(): TaskSessionPersistenceMetrics {
  return {
    taskSessionUpdateCount: 0,
    taskSessionPhysicalWriteCount: 0,
    taskSessionWriteSkippedCount: 0,
    taskSessionWriteCoalescedCount: 0,
    taskSessionRenameRetryCount: 0
  };
}

export type RunMetrics = {
  schemaVersion: 1;
  scope: "model_run" | "validation_run" | "task_run";
  runId: string;
  taskSessionId: string | null;
  provider: string;
  model: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  firstTokenLatencyMs: number | null;
  firstTokenLatencySource: "provider" | "completion_upper_bound" | "unavailable";
  usage: ModelUsage;
  // 价格未知时保持 null，禁止用 0 伪装成免费。
  estimatedCostUsd: number | null;
  safeEditorNeedsAnalysisCount: number;
  safeEditorAutoAnalysisAttemptCount: number;
  safeEditorAutoAnalysisSuccessCount: number;
  safeEditorConfirmedExpansionCount: number;
  safeEditorRiskAcknowledgementCount: number;
  safeEditorFalseExpansionRegressionCount: number;
  completionRequestCount: number;
  completionAcceptedCount: number;
  completionRejectedCount: number;
  sameEvidenceRejectionCount: number;
  approvalResumeCount: number;
  mutationEvidenceRestoreFailureCount: number;
  completionLoopStoppedCount: number;
  providerCallCount: number;
  providerCallsAfterFirstCompletionRejection: number;
  changedFileCount: number;
  inputTokensPerChangedFile: number | null;
  contextCompressionCount: number;
  completionResourceAlerts: CompletionResourceAlert[];
  completionRejections: CompletionRejectionDiagnostic[];
  taskSessionPersistence: TaskSessionPersistenceMetrics;
  progressiveDelivery: ProgressiveDeliveryMetrics;
  /** 阶段 1：子代理运行指标，记录父代理本次运行中委派和执行的所有子代理；非子代理模式运行时可能为 undefined。 */
  subagentMetrics?: SubagentMetrics;
  tools: ToolRuntimeMetrics;
  context: { compressionCount: number; estimatedTokensBefore: number | null; estimatedTokensAfter: number | null; estimator: "conservative" | "unavailable" };
  result: {
    status: RunFinalStatus;
    stopReason: AgentStopReason;
    failureCategory: RunFailureCategory;
    patchFileCount: number;
    validationCommandCount: number;
    validationStatus: "not_required" | "not_run" | "passed" | "failed" | "unavailable";
  };
};

export type RunMetricsRecorder = (metrics: RunMetrics) => Promise<void>;
export type SafeEditorMetricDelta = Partial<Pick<RunMetrics,
  | "safeEditorNeedsAnalysisCount"
  | "safeEditorAutoAnalysisAttemptCount"
  | "safeEditorAutoAnalysisSuccessCount"
  | "safeEditorConfirmedExpansionCount"
  | "safeEditorRiskAcknowledgementCount"
  | "safeEditorFalseExpansionRegressionCount"
>>;

const metricsWriteQueues = new Map<string, Promise<void>>();

export async function appendRunMetrics(metrics: RunMetrics, filePath = appStatePath("run-metrics.jsonl")) {
  const previous = metricsWriteQueues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const directory = path.dirname(filePath);
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    // 指标量有限，重写完整 JSONL 可确保并发写入时每一行仍可独立 JSON.parse。
    const existing = await fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const content = `${existing}${JSON.stringify(metrics)}\n`;
    await fs.mkdir(directory, { recursive: true });
    try {
      await fs.writeFile(temporary, content, "utf8");
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  });
  metricsWriteQueues.set(filePath, next);
  try {
    await next;
  } finally {
    if (metricsWriteQueues.get(filePath) === next) metricsWriteQueues.delete(filePath);
  }
}

export function classifyRunFailure(error: unknown): RunFailureCategory {
  const detail = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; status?: unknown; category?: unknown; message?: unknown } : {};
  if (detail.category && ["timeout", "model_error", "tool_error", "validation_failure", "cancelled", "internal_error"].includes(String(detail.category))) return detail.category as RunFailureCategory;
  if (detail.name === "AbortError" || detail.code === "ABORT_ERR" || detail.code === "AGENT_CANCELLED") return "cancelled";
  if (detail.code === "AGENT_MODEL_BUDGET_EXCEEDED") return "model_error";
  if (detail.code === "AGENT_TIMEOUT") return "timeout";
  if (detail.code === "ETIMEDOUT" || detail.code === "UND_ERR_CONNECT_TIMEOUT" || detail.status === 408 || detail.status === 504) return "timeout";
  if (typeof detail.status === "number" && detail.status >= 400) return "model_error";
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("validation")) return "validation_failure";
  if (message.includes("tool")) return "tool_error";
  if (message.includes("ai ") || message.includes("model") || message.includes("response did not include")) return "model_error";
  return "internal_error";
}

export class RunMetricsTracker {
  private readonly startedAt = Date.now();
  private usage: ModelUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  private toolCalls = 0;
  private repeatedToolCalls = 0;
  private failedToolCalls = 0;
  private completionEvidenceFailedToolCalls = 0;
  private cacheHits = 0;
  private emptyResults = 0;
  private invalidToolCalls = 0;
  private consecutiveNoProgressSteps = 0;
  private maxConsecutiveNoProgressSteps = 0;
  private recoveryAttempts = 0;
  private completionRequestCount = 0;
  private completionAcceptedCount = 0;
  private completionRejectedCount = 0;
  private sameEvidenceRejectionCount = 0;
  private approvalResumeCount = 0;
  private mutationEvidenceRestoreFailureCount = 0;
  private completionLoopStoppedCount = 0;
  private providerCallCount = 0;
  private providerCallsAfterFirstCompletionRejection = 0;
  private changedFileCount = 0;
  private readonly completionRejections: CompletionRejectionDiagnostic[] = [];
  private readonly toolCallDiagnostics = new Map<string, {
    toolName: string;
    calls: number;
    firstStep: number;
    lastStep: number;
    observedResults: number;
    emptyResults: number;
    cacheHit: boolean;
  }>();
  private firstTokenLatencyMs: number | null = null;
  private firstTokenLatencySource: RunMetrics["firstTokenLatencySource"] = "unavailable";
  private context: RunMetrics["context"] = { compressionCount: 0, estimatedTokensBefore: null, estimatedTokensAfter: null, estimator: "unavailable" };
  private price: ModelPrice | undefined;
  private safeEditorMetrics: Required<SafeEditorMetricDelta> = {
    safeEditorNeedsAnalysisCount: 0,
    safeEditorAutoAnalysisAttemptCount: 0,
    safeEditorAutoAnalysisSuccessCount: 0,
    safeEditorConfirmedExpansionCount: 0,
    safeEditorRiskAcknowledgementCount: 0,
    safeEditorFalseExpansionRegressionCount: 0
  };
  private progressiveDelivery = createEmptyProgressiveDeliveryMetrics();
  private subagentMetrics = createEmptySubagentMetrics();

  constructor(
    private readonly identity: Pick<RunMetrics, "runId" | "taskSessionId" | "provider" | "model" | "mode"> & Partial<Pick<RunMetrics, "scope">>,
    private readonly recorder: RunMetricsRecorder = appendRunMetrics,
    private readonly aggregateTaskMetrics = true
  ) {}

  addUsage(usage: ModelUsage) {
    this.usage.inputTokens += usage.inputTokens;
    this.usage.outputTokens += usage.outputTokens;
    this.usage.reasoningTokens += usage.reasoningTokens;
    this.usage.cachedInputTokens += usage.cachedInputTokens;
  }

  setPrice(price?: ModelPrice) {
    this.price = price;
  }

  /** 累加脱敏后的 Safe Editor 事件计数，忽略负数和非有限值。 */
  recordSafeEditorMetrics(delta: SafeEditorMetricDelta) {
    for (const key of Object.keys(this.safeEditorMetrics) as Array<keyof SafeEditorMetricDelta>) {
      const value = delta[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        this.safeEditorMetrics[key] += Math.floor(value);
      }
    }
  }

  private estimateCostUsd() {
    if (this.price?.inputPerMillionTokens === undefined || this.price.outputPerMillionTokens === undefined) return null;
    const uncachedInputTokens = Math.max(0, this.usage.inputTokens - this.usage.cachedInputTokens);
    const cachedRate = this.price.cachedInputPerMillionTokens ?? this.price.inputPerMillionTokens;
    return (uncachedInputTokens * this.price.inputPerMillionTokens + this.usage.cachedInputTokens * cachedRate + this.usage.outputTokens * this.price.outputPerMillionTokens) / 1_000_000;
  }

  recordToolCall(input: { toolName?: string; signature?: string; step?: number; repeated?: boolean; failed?: boolean; invalid?: boolean } = {}) {
    this.toolCalls += 1;
    if (input.repeated) this.repeatedToolCalls += 1;
    if (input.failed) this.failedToolCalls += 1;
    if (input.invalid) this.invalidToolCalls += 1;

    if (input.toolName && input.signature && input.step !== undefined) {
      const existing = this.toolCallDiagnostics.get(input.signature);
      this.toolCallDiagnostics.set(input.signature, existing
        ? { ...existing, calls: existing.calls + 1, lastStep: input.step }
        : {
            toolName: input.toolName,
            calls: 1,
            firstStep: input.step,
            lastStep: input.step,
            observedResults: 0,
            emptyResults: 0,
            cacheHit: false
          });
    }
  }

  recordToolResult(input: { signature: string; cached?: boolean; empty?: boolean; noProgress?: boolean }) {
    if (input.cached) this.cacheHits += 1;
    if (input.empty) this.emptyResults += 1;

    const diagnostic = this.toolCallDiagnostics.get(input.signature);
    if (diagnostic) {
      diagnostic.observedResults += 1;
      if (input.empty) diagnostic.emptyResults += 1;
      if (input.cached) diagnostic.cacheHit = true;
    }

    if (input.noProgress ?? Boolean(input.cached || input.empty)) {
      this.consecutiveNoProgressSteps += 1;
      this.maxConsecutiveNoProgressSteps = Math.max(this.maxConsecutiveNoProgressSteps, this.consecutiveNoProgressSteps);
    } else {
      this.consecutiveNoProgressSteps = 0;
    }
  }

  /**
   * 恢复提示开启新的策略窗口，因此清零“连续”计数，但保留历史峰值。
   */
  recordStrategyRecovery() {
    this.recoveryAttempts += 1;
    this.consecutiveNoProgressSteps = 0;
  }

  recordToolFailure(input: { completionEvidence?: boolean } = {}) {
    this.failedToolCalls += 1;
    if (input.completionEvidence !== false) this.completionEvidenceFailedToolCalls += 1;
  }

  /** 仅记录已脱敏诊断的类别，避免指标链路成为敏感工具输出的旁路存储。 */
  recordToolFailureDiagnostic(diagnostic: Pick<ToolFailureDiagnostic, "errorCategory">) {
    const category = diagnostic.errorCategory.trim().slice(0, 80) || "unknown";
    this.progressiveDelivery.toolFailuresByCategory[category] = (this.progressiveDelivery.toolFailuresByCategory[category] ?? 0) + 1;
  }

  /** 记录恢复动作及其可观察结果，用于比较灰度前后的无进展收口质量。 */
  recordRecoveryDecision(action: string) {
    const normalized = action.trim().slice(0, 80) || "unknown";
    this.progressiveDelivery.recoveryDecisions.total += 1;
    this.progressiveDelivery.recoveryDecisions.byAction[normalized] = (this.progressiveDelivery.recoveryDecisions.byAction[normalized] ?? 0) + 1;
    if (normalized === "replan") this.progressiveDelivery.noProgressTransitions.replan += 1;
    if (normalized === "await_user") this.progressiveDelivery.noProgressTransitions.awaitingUser += 1;
  }

  /** 将会话中的单元指标投影为安全摘要；标题、文件名和命令均不进入运行指标。 */
  recordDeliveryUnitSnapshot(units: readonly DeliveryUnit[] | undefined) {
    if (!units) return;
    const summaries = units.map((unit) => ({
      unitId: unit.id,
      status: unit.status,
      inputTokens: unit.contextMetrics?.inputTokens ?? 0,
      compressionCount: unit.contextMetrics?.compressionCount ?? 0,
      changedFileCount: unit.contextMetrics?.changedFileCount ?? 0,
      validationStatus: unit.contextMetrics?.validationResult ?? "not_run"
    }));
    this.progressiveDelivery.deliveryUnits = {
      total: summaries.length,
      completed: summaries.filter((unit) => unit.status === "validated").length,
      blocked: summaries.filter((unit) => unit.status === "blocked").length,
      deferred: summaries.filter((unit) => unit.status === "deferred").length
    };
    this.progressiveDelivery.unitSummaries = summaries.slice(0, 100);
  }

  // 阶段 1：子代理生命周期事件记录，用于区分父子代理的失败归属和产物维度。

  /** 父代理发起委派时调用，按子代理种类和产物类型累加计数。 */
  recordSubagentCreated(kind: SubagentKind, artifactsKind: SubagentArtifactsKind) {
    this.subagentMetrics.totalRuns += 1;
    this.subagentMetrics.byKind[kind] += 1;
    this.subagentMetrics.byArtifactsKind[artifactsKind] += 1;
  }

  /** 子代理开始执行时调用，统计新启动数（不含历史恢复）。 */
  recordSubagentStarted(kind: SubagentKind, _artifactsKind: SubagentArtifactsKind) {
    this.subagentMetrics.freshStarted += 1;
    this.subagentMetrics.byKind[kind] += 1;
    this.subagentMetrics.byArtifactsKind[_artifactsKind] += 1;
  }

  /** 子代理成功完成时调用。 */
  recordSubagentSucceeded() {
    this.subagentMetrics.byStatus.succeeded += 1;
  }

  /** 子代理执行失败时调用，可区分父代理失败还是子代理失败。 */
  recordSubagentFailed() {
    this.subagentMetrics.byStatus.failed += 1;
  }

  /** 子代理被取消时调用（用户主动取消或父代理中断委派）。 */
  recordSubagentCancelled() {
    this.subagentMetrics.byStatus.cancelled += 1;
  }

  // 阶段 6：并行运行统计记录。
  /** 记录一个并行批次的统计信息。 */
  recordSubagentParallelBatch(taskCount: number, peakConcurrency: number, totalDurationMs: number) {
    this.subagentMetrics.concurrent.batches += 1;
    this.subagentMetrics.concurrent.totalParallelTasks += taskCount;
    this.subagentMetrics.concurrent.peakConcurrency = Math.max(
      this.subagentMetrics.concurrent.peakConcurrency,
      peakConcurrency
    );
    this.subagentMetrics.concurrent.totalParallelDurationMs += totalDurationMs;
  }

  /** 为显式完成协议补充独立统计，便于从普通工具指标中识别拒绝循环。 */
  recordCompletionRequest() {
    this.completionRequestCount += 1;
  }

  recordCompletionAccepted() {
    this.completionAcceptedCount += 1;
  }

  recordCompletionRejected(input: {
    sameEvidence?: boolean;
    loopStopped?: boolean;
    diagnostic?: Omit<CompletionRejectionDiagnostic, "taskSessionId" | "runId" | "resumeCount">;
  } = {}) {
    this.completionRejectedCount += 1;
    if (input.sameEvidence) this.sameEvidenceRejectionCount += 1;
    if (input.loopStopped) this.completionLoopStoppedCount += 1;
    if (input.diagnostic) {
      this.completionRejections.push({
        taskSessionId: this.identity.taskSessionId,
        runId: this.identity.runId,
        resumeCount: this.approvalResumeCount,
        ...input.diagnostic
      });
      if (this.completionRejections.length > COMPLETION_RESOURCE_LIMITS.maxCompletionRejectionDiagnostics) {
        this.completionRejections.splice(0, this.completionRejections.length - COMPLETION_RESOURCE_LIMITS.maxCompletionRejectionDiagnostics);
      }
    }
  }

  /** 无效恢复在再次提交 completeTask 前就被拦截时，单独记录收敛停止。 */
  recordCompletionConvergenceStopped() {
    this.completionLoopStoppedCount += 1;
  }

  /** Provider 调用与拒绝后的额外调用分开统计，用于识别收敛保护是否生效。 */
  recordProviderCall() {
    this.providerCallCount += 1;
    if (this.completionRejectedCount > 0) this.providerCallsAfterFirstCompletionRejection += 1;
  }

  recordApprovalResume() {
    this.approvalResumeCount += 1;
  }

  recordMutationEvidenceRestoreFailure() {
    this.mutationEvidenceRestoreFailureCount += 1;
  }

  recordChangedFileCount(count: number) {
    if (Number.isFinite(count) && count > this.changedFileCount) this.changedFileCount = Math.floor(count);
  }

  /** 向完成策略提供只读快照，避免策略直接依赖指标对象的内部计数。 */
  getCompletionEvidenceSnapshot() {
    return { failedToolCallCount: this.completionEvidenceFailedToolCalls };
  }

  private getMostRepeatedCall(): MostRepeatedToolCall | null {
    const repeated = [...this.toolCallDiagnostics.entries()]
      .filter(([, diagnostic]) => diagnostic.calls > 1)
      .sort(([, left], [, right]) => right.calls - left.calls || left.firstStep - right.firstStep)[0];
    if (!repeated) return null;

    const [signature, diagnostic] = repeated;
    return {
      toolName: diagnostic.toolName,
      signature,
      calls: diagnostic.calls,
      repeatedCalls: diagnostic.calls - 1,
      firstStep: diagnostic.firstStep,
      lastStep: diagnostic.lastStep,
      allResultsEmpty: diagnostic.observedResults > 0 && diagnostic.emptyResults === diagnostic.observedResults,
      cacheHit: diagnostic.cacheHit
    };
  }

  recordContextEstimate(estimatedTokensBefore: number, estimatedTokensAfter = estimatedTokensBefore, compressed = false) {
    this.context.estimatedTokensBefore = estimatedTokensBefore;
    this.context.estimatedTokensAfter = estimatedTokensAfter;
    this.context.estimator = "conservative";
    if (compressed) this.context.compressionCount += 1;
  }

  recordFirstTokenLatency(value: number, source: Exclude<RunMetrics["firstTokenLatencySource"], "unavailable">) {
    if (!Number.isFinite(value) || value < 0) return;
    // Provider 精确值可以覆盖非流式完成耗时上界；同来源只保留首次观测。
    if (this.firstTokenLatencyMs === null || (source === "provider" && this.firstTokenLatencySource !== "provider")) {
      this.firstTokenLatencyMs = Math.round(value);
      this.firstTokenLatencySource = source;
    }
  }

  async finish(input: {
    status: RunFinalStatus;
    stopReason?: AgentStopReason;
    failureCategory?: RunFailureCategory;
    patchFileCount?: number;
    validationCommandCount?: number;
    validationStatus?: RunMetrics["result"]["validationStatus"];
  }) {
    const finishedAt = Date.now();
    const inputTokensPerChangedFile = this.changedFileCount > 0
      ? Math.round((this.usage.inputTokens / this.changedFileCount) * 100) / 100
      : null;
    const completionResourceAlerts: CompletionResourceAlert[] = [];
    if (inputTokensPerChangedFile !== null && inputTokensPerChangedFile > COMPLETION_RESOURCE_LIMITS.maxInputTokensPerChangedFile) {
      completionResourceAlerts.push("HIGH_INPUT_TOKENS_PER_CHANGED_FILE");
    }
    if (this.context.compressionCount > COMPLETION_RESOURCE_LIMITS.maxContextCompressionCount) {
      completionResourceAlerts.push("EXCESSIVE_CONTEXT_COMPRESSION");
    }
    if (this.providerCallsAfterFirstCompletionRejection > COMPLETION_RESOURCE_LIMITS.maxProviderCallsAfterFirstCompletionRejection) {
      completionResourceAlerts.push("EXCESSIVE_PROVIDER_CALLS_AFTER_REJECTION");
    }
    if (input.status === "completed" && this.progressiveDelivery.recoveryDecisions.total > 0) {
      this.progressiveDelivery.noProgressTransitions.successfulDelivery += 1;
    }
    const metrics: RunMetrics = {
      schemaVersion: 1,
      ...this.identity,
      scope: this.identity.scope ?? "model_run",
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - this.startedAt,
      firstTokenLatencyMs: this.firstTokenLatencyMs,
      firstTokenLatencySource: this.firstTokenLatencySource,
      usage: { ...this.usage },
      estimatedCostUsd: this.estimateCostUsd(),
      ...this.safeEditorMetrics,
      completionRequestCount: this.completionRequestCount,
      completionAcceptedCount: this.completionAcceptedCount,
      completionRejectedCount: this.completionRejectedCount,
      sameEvidenceRejectionCount: this.sameEvidenceRejectionCount,
      approvalResumeCount: this.approvalResumeCount,
      mutationEvidenceRestoreFailureCount: this.mutationEvidenceRestoreFailureCount,
      completionLoopStoppedCount: this.completionLoopStoppedCount,
      providerCallCount: this.providerCallCount,
      providerCallsAfterFirstCompletionRejection: this.providerCallsAfterFirstCompletionRejection,
      changedFileCount: this.changedFileCount,
      inputTokensPerChangedFile,
      contextCompressionCount: this.context.compressionCount,
      completionResourceAlerts,
      completionRejections: structuredClone(this.completionRejections),
      taskSessionPersistence: createEmptyTaskSessionPersistenceMetrics(),
      progressiveDelivery: structuredClone(this.progressiveDelivery),
      subagentMetrics: structuredClone(this.subagentMetrics),
      tools: {
        calls: this.toolCalls,
        repeatedCalls: this.repeatedToolCalls,
        cacheHits: this.cacheHits,
        emptyResults: this.emptyResults,
        invalidToolCalls: this.invalidToolCalls,
        consecutiveNoProgressSteps: this.consecutiveNoProgressSteps,
        maxConsecutiveNoProgressSteps: this.maxConsecutiveNoProgressSteps,
        recoveryAttempts: this.recoveryAttempts,
        failedCalls: this.failedToolCalls,
        mostRepeatedCall: this.getMostRepeatedCall()
      },
      context: { ...this.context },
      result: {
        status: input.status,
        stopReason: input.stopReason ?? (input.status === "completed"
          ? "completed"
          : input.status === "awaiting_approval"
            ? "awaiting_approval"
            : input.status === "incomplete"
              ? "incomplete"
              : input.status === "blocked"
                ? "blocked"
            : input.status === "cancelled"
              ? "cancelled"
              : input.status === "step_limit_reached"
                ? "step_limit"
                : "provider_error"),
        failureCategory: input.failureCategory ?? "none",
        patchFileCount: input.patchFileCount ?? 0,
        validationCommandCount: input.validationCommandCount ?? 0,
        validationStatus: input.validationStatus ?? "not_run"
      }
    };
    try {
      await this.recorder(metrics);
    } catch (error) {
      // 可观测性故障不能改变 Agent 主流程，只输出不含业务正文的简短告警。
      console.warn("[metrics] failed to persist run metrics", error instanceof Error ? error.message : "unknown error");
    }
    if (this.aggregateTaskMetrics) {
      const { mergeTaskMetrics } = await import("./taskMetrics.js");
      await mergeTaskMetrics(metrics);
    }
    return metrics;
  }
}
