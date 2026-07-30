import fs from "node:fs/promises";
import path from "node:path";
import { appStatePath } from "../statePaths.js";
import type { ModelPrice, ModelUsage } from "../contracts/model.js";

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
  tools: ToolRuntimeMetrics;
  context: { compressionCount: number; estimatedTokensBefore: number | null; estimatedTokensAfter: number | null; estimator: "conservative" | "unavailable" };
  result: {
    status: RunFinalStatus;
    stopReason: AgentStopReason;
    failureCategory: RunFailureCategory;
    patchFileCount: number;
    validationCommandCount: number;
    validationStatus: "not_run" | "passed" | "failed";
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
  if (detail.name === "AbortError" || detail.code === "ABORT_ERR") return "cancelled";
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
  private cacheHits = 0;
  private emptyResults = 0;
  private invalidToolCalls = 0;
  private consecutiveNoProgressSteps = 0;
  private maxConsecutiveNoProgressSteps = 0;
  private recoveryAttempts = 0;
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

  recordToolFailure() {
    this.failedToolCalls += 1;
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
