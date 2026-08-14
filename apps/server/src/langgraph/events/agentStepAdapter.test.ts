import assert from "node:assert/strict";
import test from "node:test";
import { graphEventToAgentStep } from "./agentStepAdapter.js";
import { streamGraphAgentSteps } from "./graphEventStream.js";

test("Graph node/task/update/interrupt/final 事件映射为现有 AgentStep", () => {
  const base = { runId: "run-1", sequence: 1 };
  const node = graphEventToAgentStep({ ...base, type: "node", node: "planner", phase: "started" });
  const task = graphEventToAgentStep({ ...base, sequence: 2, type: "task", node: "explorer", taskId: "E1", status: "success" });
  const update = graphEventToAgentStep({ ...base, sequence: 3, type: "update", summary: "已合并 2 项事实" });
  const interrupted = graphEventToAgentStep({ ...base, sequence: 4, type: "interrupt", actionId: "action-1", summary: "确认继续" });
  const final = graphEventToAgentStep({ ...base, sequence: 5, type: "final", summary: "规划完成" });

  assert.equal(node.type, "orchestration");
  assert.equal(node.type === "orchestration" && node.agent, "planner");
  assert.equal(task.type === "orchestration" && task.taskId, "E1");
  assert.equal(update.type, "message");
  assert.equal(interrupted.type, "approval_request");
  assert.equal(final.type, "message");
});

test("事件 ID 可重放去重且摘要会被截断", () => {
  const event = { runId: "run-1", sequence: 1, type: "final" as const, summary: "x".repeat(1000) };
  const first = graphEventToAgentStep(event);
  const second = graphEventToAgentStep(event);
  assert.equal(first.id, second.id);
  assert.equal(first.type === "message" && first.content.length, 500);
});

test("Graph 事件流在恢复重放时不重复持久化步骤", async () => {
  async function* events() {
    yield { runId: "run-1", sequence: 1, type: "node" as const, node: "planner", phase: "started" as const };
    yield { runId: "run-1", sequence: 1, type: "node" as const, node: "planner", phase: "started" as const };
    yield { runId: "run-1", sequence: 2, type: "final" as const, summary: "完成" };
  }
  const persisted: string[] = [];
  const steps = [];
  for await (const step of streamGraphAgentSteps(events(), { onStep: (value) => { persisted.push(value.id); } })) steps.push(step);
  assert.equal(steps.length, 2);
  assert.deepEqual(persisted, steps.map((step) => step.id));
});
