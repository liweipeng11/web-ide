import fs from "node:fs/promises";
import path from "node:path";
import { appStatePath } from "../statePaths.js";
import type { ModelUsage } from "../contracts/model.js";

export type RunFailureCategory = "none" | "timeout" | "model_error" | "tool_error" | "validation_failure" | "cancelled" | "step_limit" | "internal_error";
export type RunFinalStatus = "completed" | "awaiting_approval" | "failed" | "cancelled" | "step_limit_reached";

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
  tools: { calls: number; repeatedCalls: number; failedCalls: number };
  context: { compressionCount: number; estimatedTokensBefore: number | null; estimatedTokensAfter: number | null; estimator: "conservative" | "unavailable" };
  result: {
    status: RunFinalStatus;
    failureCategory: RunFailureCategory;
    patchFileCount: number;
    validationCommandCount: number;
    validationStatus: "not_run" | "passed" | "failed";
  };
};

export type RunMetricsRecorder = (metrics: RunMetrics) => Promise<void>;

export async function appendRunMetrics(metrics: RunMetrics, filePath = appStatePath("run-metrics.jsonl")) {
  // 仅持久化白名单指标字段；类型中不允许请求正文、Header、密钥或文件内容进入日志。
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(metrics)}\n`, "utf8");
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
  private firstTokenLatencyMs: number | null = null;
  private firstTokenLatencySource: RunMetrics["firstTokenLatencySource"] = "unavailable";
  private context: RunMetrics["context"] = { compressionCount: 0, estimatedTokensBefore: null, estimatedTokensAfter: null, estimator: "unavailable" };

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

  recordToolCall(input: { repeated?: boolean; failed?: boolean } = {}) {
    this.toolCalls += 1;
    if (input.repeated) this.repeatedToolCalls += 1;
    if (input.failed) this.failedToolCalls += 1;
  }

  recordToolFailure() {
    this.failedToolCalls += 1;
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
      tools: { calls: this.toolCalls, repeatedCalls: this.repeatedToolCalls, failedCalls: this.failedToolCalls },
      context: { ...this.context },
      result: {
        status: input.status,
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
