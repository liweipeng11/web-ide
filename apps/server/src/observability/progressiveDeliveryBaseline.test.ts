import assert from "node:assert/strict";
import test from "node:test";
import { RunMetricsTracker } from "./runMetrics.js";
import { summarizeProgressiveDeliveryBaseline } from "./progressiveDeliveryBaseline.js";

test("渐进交付基线只使用任务最终快照，并固定五项阶段零指标口径", async () => {
  const noProgress = new RunMetricsTracker({ runId: "baseline-a", taskSessionId: "task-a", provider: "mock", model: "mock", mode: "act", scope: "task_run" }, async () => undefined, false);
  noProgress.recordContextEstimate(100, 50, true);
  noProgress.recordToolFailure();
  noProgress.recordApprovalResume();
  const noProgressMetrics = await noProgress.finish({ status: "incomplete", stopReason: "no_progress" });

  const withPatch = new RunMetricsTracker({ runId: "baseline-b", taskSessionId: "task-b", provider: "mock", model: "mock", mode: "act", scope: "task_run" }, async () => undefined, false);
  withPatch.recordContextEstimate(100, 50, true);
  withPatch.recordContextEstimate(100, 50, true);
  const withPatchMetrics = await withPatch.finish({ status: "incomplete", stopReason: "no_progress", patchFileCount: 1 });

  const ignoredRun = await new RunMetricsTracker({ runId: "baseline-c", taskSessionId: "task-c", provider: "mock", model: "mock", mode: "act" }, async () => undefined, false)
    .finish({ status: "incomplete", stopReason: "no_progress" });

  assert.deepEqual(summarizeProgressiveDeliveryBaseline([noProgressMetrics, withPatchMetrics, ignoredRun]), {
    taskCount: 2,
    noProgressStopCount: 2,
    noProgressStopRate: 1,
    noPatchStopCount: 1,
    noPatchStopRate: 0.5,
    contextCompressionCountPerTask: 1.5,
    failedToolCallCount: 1,
    manualResumeCount: 1
  });
});
