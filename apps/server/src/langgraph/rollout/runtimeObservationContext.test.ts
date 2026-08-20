import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeObservationContext, withRuntimeObservationContext } from "./runtimeObservationContext.js";

test("控制面观测上下文默认未知且支持嵌套恢复", async () => {
  assert.deepEqual(getRuntimeObservationContext(), { controlPlane: "unknown", rolloutMode: "unknown" });
  await withRuntimeObservationContext({ controlPlane: "legacy", rolloutMode: "50" }, async () => {
    assert.deepEqual(getRuntimeObservationContext(), { controlPlane: "legacy", rolloutMode: "50" });
    await withRuntimeObservationContext({ controlPlane: "langgraph", rolloutMode: "all" }, async () => {
      assert.deepEqual(getRuntimeObservationContext(), { controlPlane: "langgraph", rolloutMode: "all" });
    });
    assert.deepEqual(getRuntimeObservationContext(), { controlPlane: "legacy", rolloutMode: "50" });
  });
  assert.deepEqual(getRuntimeObservationContext(), { controlPlane: "unknown", rolloutMode: "unknown" });
});

test("并发任务的控制面来源互不污染", async () => {
  const [legacy, graph] = await Promise.all([
    withRuntimeObservationContext({ controlPlane: "legacy", rolloutMode: "off" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getRuntimeObservationContext();
    }),
    withRuntimeObservationContext({ controlPlane: "langgraph", rolloutMode: "all" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getRuntimeObservationContext();
    })
  ]);
  assert.deepEqual(legacy, { controlPlane: "legacy", rolloutMode: "off" });
  assert.deepEqual(graph, { controlPlane: "langgraph", rolloutMode: "all" });
});
