import test from "node:test";
import assert from "node:assert/strict";
import type { TaskSession } from "../types.js";
import { runApprovedPipelineGraph } from "./approvedPipelineGraph.js";

function session(overrides: Partial<TaskSession> = {}): TaskSession {
  return {
    id: "task-1",
    agentMode: "act",
    planApproval: { status: "approved" },
    runtimePlan: { version: 1, goal: "测试", assumptions: [], completionCriteria: [], tasks: [] },
    ...overrides
  } as TaskSession;
}

test("批准且有计划的任务只执行一次", async () => {
  let calls = 0;
  const result = await runApprovedPipelineGraph(session(), async (value) => {
    calls += 1;
    return { sessionId: value.id };
  });
  assert.deepEqual(result, { outcome: "executed", value: { sessionId: "task-1" } });
  assert.equal(calls, 1);
});

test("未批准、非 act 或缺少计划时安全停止且不执行", async () => {
  const cases = [
    session({ planApproval: { status: "pending" } as TaskSession["planApproval"] }),
    session({ agentMode: "plan" }),
    session({ runtimePlan: undefined })
  ];
  for (const value of cases) {
    let called = false;
    const result = await runApprovedPipelineGraph(value, async () => {
      called = true;
      return null;
    });
    assert.equal(result.outcome, "not_applicable");
    assert.equal(called, false);
  }
});
