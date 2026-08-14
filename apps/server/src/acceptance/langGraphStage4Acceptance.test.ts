import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskSessionCheckpointer } from "../langgraph/persistence/taskSessionCheckpointer.js";
import { approvalGraphConfig, approvalGraphInput, createApprovalInterruptGraph } from "../langgraph/interrupts/approvalInterrupt.js";
import { resumeApprovalGraph } from "../langgraph/interrupts/resumeGraph.js";
import { streamGraphAgentSteps } from "../langgraph/events/graphEventStream.js";

test("阶段 4 checkpoint、恢复、幂等 resume 与 AgentStep 兼容验收", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-stage4-"));
  let decisions = 0;
  const originalFiles = await fs.readdir(directory);
  try {
    const input = approvalGraphInput({
      taskSessionId: "acceptance-task",
      actionKey: "read-only-review",
      title: "确认只读流程",
      summary: "审批不会执行写入"
    });
    const initialGraph = createApprovalInterruptGraph({ checkpointer: new TaskSessionCheckpointer(directory) });
    await initialGraph.invoke(input, approvalGraphConfig(input.taskSessionId));

    const restartedGraph = createApprovalInterruptGraph({
      checkpointer: new TaskSessionCheckpointer(directory),
      onDecision: () => { decisions += 1; }
    });
    const first = await resumeApprovalGraph(restartedGraph, input.taskSessionId, "approved");
    const replay = await resumeApprovalGraph(restartedGraph, input.taskSessionId, "approved");

    async function* events() {
      yield { runId: "stage4", sequence: 1, type: "interrupt" as const, actionId: input.actionId, summary: input.summary };
      yield { runId: "stage4", sequence: 2, type: "final" as const, summary: "只读审批完成" };
    }
    const steps = [];
    for await (const step of streamGraphAgentSteps(events())) steps.push(step);

    assert.equal(first.state.status, "approved");
    assert.equal(replay.replayed, true);
    assert.equal(decisions, 1);
    assert.deepEqual(steps.map((step) => step.type), ["approval_request", "message"]);
    assert.deepEqual(originalFiles, []);
    assert.equal((await fs.readdir(directory)).every((name) => name.endsWith(".json") || name.endsWith(".bak")), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

