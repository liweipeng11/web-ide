import assert from "node:assert/strict";
import test from "node:test";
import { executeReadOnlyRuntimeRollout, selectReadOnlyRuntime, type ReadOnlyRuntimeObservation } from "./runtimeSelector.js";

test("运行选择器严格区分 off、shadow 和显式 internal", () => {
  assert.deepEqual(selectReadOnlyRuntime({ mode: "off", nextAvailable: true }), { runLegacy: true, runNext: false, useNextResult: false });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "shadow", nextAvailable: true }), { runLegacy: true, runNext: true, useNextResult: false });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "internal", internalTask: false, nextAvailable: true }), { runLegacy: true, runNext: false, useNextResult: false });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "internal", internalTask: true, nextAvailable: true }), { runLegacy: false, runNext: true, useNextResult: true });
  assert.deepEqual(selectReadOnlyRuntime({ mode: "internal", internalTask: true, nextAvailable: false }), { runLegacy: true, runNext: false, useNextResult: false });
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

test("internal 仅对显式内部任务采用新结果，并在新路径失败时回退", async () => {
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
  assert.equal(await executeReadOnlyRuntimeRollout({
    mode: "internal",
    internalTask: true,
    legacy: async () => "legacy",
    next: async () => { throw new Error("next failed"); }
  }), "legacy");
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
