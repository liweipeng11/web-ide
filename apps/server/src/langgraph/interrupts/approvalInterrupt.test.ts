import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isInterrupted } from "@langchain/langgraph";
import { TaskSessionCheckpointer } from "../persistence/taskSessionCheckpointer.js";
import { approvalGraphConfig, approvalGraphInput, createApprovalInterruptGraph } from "./approvalInterrupt.js";
import { resumeApprovalGraph } from "./resumeGraph.js";

test("审批图可在服务重启后恢复，重复 resume 不重复推进决定节点", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-approval-"));
  let decisionCalls = 0;
  try {
    const input = approvalGraphInput({ taskSessionId: "task-1", actionKey: "review", title: "确认计划", summary: "是否继续只读图" });
    const firstGraph = createApprovalInterruptGraph({ checkpointer: new TaskSessionCheckpointer(directory) });
    const interrupted = await firstGraph.invoke(input, approvalGraphConfig("task-1"));
    assert.equal(isInterrupted(interrupted), true);

    // 新图和 saver 模拟进程重启；恢复后只调用一次结构化决定回调。
    const restarted = createApprovalInterruptGraph({
      checkpointer: new TaskSessionCheckpointer(directory),
      onDecision: () => { decisionCalls += 1; }
    });
    const resumed = await resumeApprovalGraph(restarted, "task-1", "approved");
    const replayed = await resumeApprovalGraph(restarted, "task-1", "approved");

    assert.equal(resumed.state.status, "approved");
    assert.equal(resumed.replayed, false);
    assert.equal(replayed.replayed, true);
    assert.equal(decisionCalls, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("不同任务的审批 checkpoint 完全隔离", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-approval-isolation-"));
  try {
    const graph = createApprovalInterruptGraph({ checkpointer: new TaskSessionCheckpointer(directory) });
    await graph.invoke(approvalGraphInput({ taskSessionId: "task-a", actionKey: "review", title: "A", summary: "A" }), approvalGraphConfig("task-a"));
    await graph.invoke(approvalGraphInput({ taskSessionId: "task-b", actionKey: "review", title: "B", summary: "B" }), approvalGraphConfig("task-b"));
    await resumeApprovalGraph(graph, "task-a", "rejected");

    const stateA = await graph.getState(approvalGraphConfig("task-a"));
    const stateB = await graph.getState(approvalGraphConfig("task-b"));
    assert.equal(stateA.values.status, "rejected");
    assert.equal(stateB.values.status, "pending");
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
