import assert from "node:assert/strict";
import test from "node:test";
import { getStableRolloutBucket } from "../../featureFlags.js";
import { executeReadOnlyRuntimeRollout, selectReadOnlyRuntime, type ReadOnlyRuntimeObservation } from "./runtimeSelector.js";

function taskKeyInRange(minimum: number, maximum: number) {
  for (let index = 0; index < 10_000; index += 1) {
    const taskKey = `task-session-${index}`;
    const bucket = getStableRolloutBucket(taskKey);
    if (bucket >= minimum && bucket < maximum) return taskKey;
  }
  throw new Error(`未找到 ${minimum}-${maximum} 的稳定灰度测试键。`);
}

test("运行选择器严格区分 off、shadow 和显式 internal", () => {
  assert.deepEqual(selectReadOnlyRuntime({ mode: "off", nextAvailable: true }), { runLegacy: true, runNext: false, useNextResult: false });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "shadow", nextAvailable: true }), { runLegacy: true, runNext: true, useNextResult: false });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "internal", internalTask: false, nextAvailable: true }), { runLegacy: true, runNext: false, useNextResult: false });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "internal", internalTask: true, nextAvailable: true }), { runLegacy: false, runNext: true, useNextResult: true });
  assert.throws(
    () => selectReadOnlyRuntime({ mode: "internal", internalTask: true, nextAvailable: false }),
    /没有可用的 LangGraph 执行器/
  );
  assert.throws(
    () => selectReadOnlyRuntime({ mode: "shadow", nextAvailable: false }),
    /没有可用的 LangGraph 执行器/
  );
});

test("百分比模式按稳定任务键选择只读 LangGraph 路径", () => {
  const firstTen = taskKeyInRange(0, 10);
  const middle = taskKeyInRange(10, 50);
  const lastHalf = taskKeyInRange(50, 100);
  const next = { runLegacy: false, runNext: true, useNextResult: true };
  const legacy = { runLegacy: true, runNext: false, useNextResult: false };

  assert.deepEqual(selectReadOnlyRuntime({ mode: "10", taskKey: firstTen, nextAvailable: true }), next);
  assert.deepEqual(selectReadOnlyRuntime({ mode: "10", taskKey: middle, nextAvailable: true }), legacy);
  assert.deepEqual(selectReadOnlyRuntime({ mode: "50", taskKey: middle, nextAvailable: true }), next);
  assert.deepEqual(selectReadOnlyRuntime({ mode: "50", taskKey: lastHalf, nextAvailable: true }), legacy);
  assert.deepEqual(selectReadOnlyRuntime({ mode: "all", nextAvailable: true }), next);
  assert.deepEqual(selectReadOnlyRuntime({ mode: "50", nextAvailable: true }), legacy);
  assert.throws(
    () => selectReadOnlyRuntime({ mode: "50", taskKey: middle, nextAvailable: false }),
    /没有可用的 LangGraph 执行器/
  );
  assert.deepEqual(
    selectReadOnlyRuntime({ mode: "50", taskKey: middle, nextAvailable: true }),
    selectReadOnlyRuntime({ mode: "50", taskKey: middle, nextAvailable: true })
  );
  assert.throws(
    () => selectReadOnlyRuntime({ mode: "all", nextAvailable: false }),
    /没有可用的 LangGraph 执行器/
  );
});

test("任何选中结果来源的模式在 Graph 失败时都不回退 Legacy", async () => {
  const taskKey = taskKeyInRange(0, 10);
  let legacyCalls = 0;
  for (const input of [
    { mode: "internal" as const, internalTask: true },
    { mode: "10" as const, taskKey },
    { mode: "all" as const }
  ]) {
    await assert.rejects(executeReadOnlyRuntimeRollout({
      ...input,
      legacy: async () => { legacyCalls += 1; return "legacy"; },
      next: async () => { throw new Error("graph failed"); }
    }), /graph failed/);
  }
  assert.equal(legacyCalls, 0);
});

test("shadow 执行新路径但始终返回 Legacy 结果，观测不包含内容", async () => {
  let observation: ReadOnlyRuntimeObservation | undefined;
  const result = await executeReadOnlyRuntimeRollout({
    mode: "shadow",
    legacy: async () => ({ status: "success", secret: "legacy source" }),
    next: async () => ({ status: "success", secret: "next source" }),
    equivalent: (legacy, next) => legacy.status === next.status,
    observe: (value) => { observation = value; }
  });

  assert.equal(result.secret, "legacy source");
  assert.deepEqual(observation, {
    mode: "shadow",
    selected: "legacy",
    legacyStatus: "completed",
    nextStatus: "completed",
    equivalent: true
  });
  assert.equal(JSON.stringify(observation).includes("source"), false);
});

test("internal 仅对显式内部任务采用新结果", async () => {
  assert.equal(await executeReadOnlyRuntimeRollout({
    mode: "internal",
    internalTask: false,
    legacy: async () => "legacy",
    next: async () => "next"
  }), "legacy");
  assert.equal(await executeReadOnlyRuntimeRollout({
    mode: "internal",
    internalTask: true,
    legacy: async () => "legacy",
    next: async () => "next"
  }), "next");
});

test("百分比灰度命中后采用新结果", async () => {
  const taskKey = taskKeyInRange(0, 10);
  assert.equal(await executeReadOnlyRuntimeRollout({
    mode: "10",
    taskKey,
    legacy: async () => "legacy",
    next: async () => "next"
  }), "next");
});

test("shadow 观测器失败不会改变 Legacy 用户结果", async () => {
  const result = await executeReadOnlyRuntimeRollout({
    mode: "shadow",
    legacy: async () => "legacy",
    next: async () => "next",
    observe: () => { throw new Error("metrics unavailable"); }
  });
  assert.equal(result, "legacy");
});

test("shadow 生成脱敏结构差异和耗时区间", async () => {
  let observation: ReadOnlyRuntimeObservation | undefined;
  const result = await executeReadOnlyRuntimeRollout({
    mode: "shadow",
    legacy: async () => ({ outcome: "executed", status: "success", secret: "legacy answer" }),
    next: async () => ({ outcome: "executed", status: "failed", secret: "next answer" }),
    describe: (value) => ({ outcome: value.outcome, result_status: value.status, route: value.secret }),
    observe: (value) => { observation = value; }
  });

  assert.equal(result.secret, "legacy answer");
  assert.deepEqual(observation?.comparison, {
    comparedDimensions: 3,
    differingDimensions: ["result_status", "route"],
    equivalent: false
  });
  assert.equal(observation?.legacyDuration, "lt_100ms");
  assert.equal(observation?.nextDuration, "lt_100ms");
  assert.equal(JSON.stringify(observation).includes("answer"), false);
});
