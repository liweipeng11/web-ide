import assert from "node:assert/strict";
import test from "node:test";
import { graphActionId, graphApprovalActionId, graphCheckpointNamespace, graphThreadIdForTask } from "./threadIdentity.js";

test("相同任务在重试与服务重启后得到稳定 thread ID", () => {
  assert.equal(graphThreadIdForTask("task-1"), graphThreadIdForTask("task-1"));
  assert.notEqual(graphThreadIdForTask("task-1"), graphThreadIdForTask("task-2"));
  assert.notEqual(graphThreadIdForTask("task-1", "planning"), graphThreadIdForTask("task-1", "approval"));
  assert.match(graphThreadIdForTask("含中文/路径"), /^task-[a-f0-9]{32}$/);
});

test("Graph namespace 与审批 action ID 稳定且彼此隔离", () => {
  assert.equal(graphCheckpointNamespace("approval"), graphCheckpointNamespace("approval"));
  assert.notEqual(graphCheckpointNamespace("approval"), graphCheckpointNamespace("planning"));
  assert.equal(graphApprovalActionId("task-1", "review"), graphApprovalActionId("task-1", "review"));
  assert.notEqual(graphApprovalActionId("task-1", "review"), graphApprovalActionId("task-1", "other"));
  assert.equal(graphActionId("I1", "run-1", "patch"), graphActionId("I1", "run-1", "patch"));
  assert.notEqual(graphActionId("I1", "run-1", "patch"), graphActionId("I1", "run-2", "patch"));
});
