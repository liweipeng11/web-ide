import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MainGraphBranchResult } from "./mainGraph.js";
import {
  readApprovedTaskSessionMainGraphState,
  routeApprovedTaskSession,
  runApprovedTaskSessionMainGraph
} from "./taskSessionMainGraph.js";
import type { Plan } from "../../runtime/contracts.js";
import type { TaskSession } from "../../types.js";
import { TaskSessionCheckpointer } from "../persistence/taskSessionCheckpointer.js";

function plan(withExploration = false): Plan {
  return {
    version: 1,
    goal: "修改并验证认证逻辑",
    assumptions: [],
    completionCriteria: ["测试通过"],
    tasks: [
      ...(withExploration ? [{
        id: "E1",
        type: "explore" as const,
        goal: "定位认证实现",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/**"],
        writeScope: [],
        acceptanceCriteria: ["定位实现"],
        status: "completed" as const
      }] : []),
      {
        id: "T1",
        type: "implement",
        goal: "修改认证逻辑",
        dependencies: withExploration ? ["E1"] : [],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth.ts"],
        writeScope: ["src/auth.ts"],
        acceptanceCriteria: ["修改完成"],
        status: "pending"
      }
    ]
  };
}

function session(runtimePlan: Plan = plan()): TaskSession {
  return {
    id: "task-main-graph",
    userGoal: runtimePlan.goal,
    agentMode: "act",
    planApproval: { status: "approved" },
    runtimePlan
  } as TaskSession;
}

function completed(summary = "执行完成"): MainGraphBranchResult {
  return { outcome: "completed", summary, changedFiles: ["src/auth.ts"] };
}

test("已批准的 medium 计划进入 main_loop 且只执行一次现有流水线", async () => {
  const current = session();
  let calls = 0;
  const result = await runApprovedTaskSessionMainGraph({
    session: current,
    async execute() {
      calls += 1;
      return { summary: "修改完成" };
    },
    describe: (value) => completed(value.summary)
  });

  assert.equal(result.graph.branch, "main_loop");
  assert.equal(result.graph.outcome, "completed");
  assert.equal(result.value.summary, "修改完成");
  assert.equal(calls, 1);
});

test("包含 Explorer 的复杂计划从 TaskSession 恢复后进入 planned", async () => {
  const current = session(plan(true));
  const result = await runApprovedTaskSessionMainGraph({
    session: current,
    async execute() { return { status: "blocked" }; },
    describe: () => ({ outcome: "blocked", summary: "等待范围确认", blockers: ["范围不足"] })
  });

  assert.equal(routeApprovedTaskSession(current).route, "planned");
  assert.equal(result.graph.branch, "planned");
  assert.equal(result.graph.planning, current.runtimePlan);
  assert.equal(result.graph.outcome, "blocked");
});

test("缺少 Runtime Plan 或执行前取消时不会启动副作用", async () => {
  assert.throws(
    () => routeApprovedTaskSession({ ...session(), runtimePlan: undefined }),
    /缺少 Runtime Plan/
  );

  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(runApprovedTaskSessionMainGraph({
    session: session(),
    signal: controller.signal,
    async execute() {
      calls += 1;
      return { summary: "不应执行" };
    },
    describe: () => completed()
  }), /未执行已批准的任务流水线/);
  assert.equal(calls, 0);
});

test("未批准任务停留在 TaskSession 审批边界且不会启动 Graph", async () => {
  const pending = {
    ...session(),
    planApproval: { required: true, status: "pending" as const }
  };
  let calls = 0;
  await assert.rejects(runApprovedTaskSessionMainGraph({
    session: pending,
    async execute() {
      calls += 1;
      return { summary: "不应执行" };
    },
    describe: () => completed()
  }), /尚未批准/);
  assert.equal(calls, 0);
});

test("Graph 事件可实时推送，重启后恢复快照且重放步骤不重复", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "task-session-main-graph-"));
  try {
    const current = session();
    const steps: string[] = [];
    const firstCheckpointer = new TaskSessionCheckpointer(directory);
    const result = await runApprovedTaskSessionMainGraph({
      session: current,
      checkpointer: firstCheckpointer,
      onGraphStep(step) { steps.push(step.id); },
      async execute() { return { summary: "已完成持久化执行" }; },
      describe: (value) => completed(value.summary)
    });
    assert.equal(result.graph.outcome, "completed");
    assert.ok(steps.length >= 5);
    assert.equal(new Set(steps).size, steps.length);

    // 新 checkpointer 实例模拟服务重启；读取快照不会调用任何执行节点。
    const snapshot = await readApprovedTaskSessionMainGraphState({
      session: current,
      checkpointer: new TaskSessionCheckpointer(directory)
    });
    assert.equal(snapshot?.outcome, "completed");
    assert.equal(snapshot?.branch, "main_loop");

    const replayed: string[] = [];
    await runApprovedTaskSessionMainGraph({
      session: { ...current, steps: steps.map((id) => ({ id, createdAt: Date.now(), type: "message", content: "已恢复" })) },
      checkpointer: new TaskSessionCheckpointer(directory),
      onGraphStep(step) { replayed.push(step.id); },
      async execute() { return { summary: "重放" }; },
      describe: (value) => completed(value.summary)
    });
    assert.deepEqual(replayed, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
