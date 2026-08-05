import type { RunMetrics } from "./runMetrics.js";

/** 阶段 0 仅汇总既有运行结果，用于后续灰度前后的同口径比较。 */
export type ProgressiveDeliveryBaseline = {
  taskCount: number;
  noProgressStopCount: number;
  noProgressStopRate: number;
  noPatchStopCount: number;
  noPatchStopRate: number;
  contextCompressionCountPerTask: number;
  failedToolCallCount: number;
  manualResumeCount: number;
};

/**
 * 以任务维度的最终快照计算基线，避免把同一任务的多个模型轮次误算为多个样本。
 * 调用方应传入 task_run 指标；其他 scope 会被忽略以保证指标口径稳定。
 */
export function summarizeProgressiveDeliveryBaseline(metrics: readonly RunMetrics[]): ProgressiveDeliveryBaseline {
  const taskMetrics = metrics.filter((item) => item.scope === "task_run");
  const taskCount = taskMetrics.length;
  const noProgressStopCount = taskMetrics.filter((item) => item.result.stopReason === "no_progress").length;
  const noPatchStopCount = taskMetrics.filter((item) =>
    item.result.stopReason === "no_progress" && item.result.patchFileCount === 0
  ).length;
  const contextCompressionCount = taskMetrics.reduce((total, item) => total + item.contextCompressionCount, 0);
  const failedToolCallCount = taskMetrics.reduce((total, item) => total + item.tools.failedCalls, 0);
  const manualResumeCount = taskMetrics.reduce((total, item) => total + item.approvalResumeCount, 0);

  return {
    taskCount,
    noProgressStopCount,
    noProgressStopRate: taskCount === 0 ? 0 : noProgressStopCount / taskCount,
    noPatchStopCount,
    noPatchStopRate: taskCount === 0 ? 0 : noPatchStopCount / taskCount,
    contextCompressionCountPerTask: taskCount === 0 ? 0 : contextCompressionCount / taskCount,
    failedToolCallCount,
    manualResumeCount
  };
}
