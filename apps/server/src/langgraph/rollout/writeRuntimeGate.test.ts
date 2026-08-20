import assert from "node:assert/strict";
import test from "node:test";
import type { TaskSession } from "../../types.js";
import {
  hasNewTaskSideEffects,
  InMemoryWriteRuntimeGate,
  selectWriteRuntime,
  snapshotTaskSideEffects
} from "./writeRuntimeGate.js";

function session(overrides: Partial<TaskSession> = {}): TaskSession {
  return {
    id: "task-write-rollout",
    userGoal: "修改文件",
    status: "running",
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    steps: [],
    checkpointIds: [],
    ...overrides
  } as TaskSession;
}

test("写任务按 TaskSession 稳定分桶且 shadow 不重复真实副作用", () => {
  assert.equal(selectWriteRuntime({ enabled: true, mode: "shadow", taskKey: "task-1" }), "legacy");
  assert.equal(selectWriteRuntime({ enabled: true, mode: "all", taskKey: "task-1" }), "graph");
  assert.equal(selectWriteRuntime({ enabled: false, mode: "all", taskKey: "task-1" }), "legacy");

  const first = selectWriteRuntime({ enabled: true, mode: "50", taskKey: "stable-task" });
  const second = selectWriteRuntime({ enabled: true, mode: "50", taskKey: "stable-task" });
  assert.equal(first, second);
});

test("internal 模式和熔断状态均不能被普通任务绕过", () => {
  assert.equal(selectWriteRuntime({ enabled: true, mode: "internal", taskKey: "task-1" }), "legacy");
  assert.equal(selectWriteRuntime({ enabled: true, mode: "internal", taskKey: "task-1", internalTask: true }), "graph");
  assert.throws(
    () => selectWriteRuntime({ enabled: true, mode: "all", taskKey: "task-1", gateOpen: true }),
    /安全门已熔断/
  );
  assert.throws(
    () => selectWriteRuntime({ enabled: true, mode: "internal", taskKey: "task-1", internalTask: true, gateOpen: true }),
    /安全门已熔断/
  );

  const gate = new InMemoryWriteRuntimeGate();
  gate.trip("scope_violation");
  gate.trip("runtime_failure");
  assert.equal(gate.isOpen(), true);
  assert.equal(gate.reason(), "scope_violation");
});

test("副作用快照识别新增文件、Checkpoint 和命令，忽略重复持久化值", () => {
  const before = snapshotTaskSideEffects(session({
    filesChanged: ["src/a.ts"],
    commandsRun: ["pnpm test"],
    checkpointIds: ["checkpoint-1"]
  }));
  const unchanged = snapshotTaskSideEffects(session({
    filesChanged: ["src/a.ts"],
    commandsRun: ["pnpm test"],
    checkpointIds: ["checkpoint-1"]
  }));
  const changed = snapshotTaskSideEffects(session({
    filesChanged: ["src/a.ts", "src/b.ts"],
    commandsRun: ["pnpm test"],
    checkpointIds: ["checkpoint-1"]
  }));

  assert.equal(hasNewTaskSideEffects(before, unchanged), false);
  assert.equal(hasNewTaskSideEffects(before, changed), true);
});
