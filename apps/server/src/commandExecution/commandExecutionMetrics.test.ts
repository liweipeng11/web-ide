import assert from "node:assert/strict";
import test from "node:test";
import { CommandExecutionMetrics } from "./commandExecutionMetrics.js";
import type { CommandExecution } from "./types.js";

function execution(overrides: Partial<CommandExecution> = {}): CommandExecution {
  return {
    id: "cmd-metrics", command: "npm test", cwd: process.cwd(), initiator: "validation", mode: "foreground",
    shell: { name: "test", capability: "basic" }, state: "succeeded", readiness: "not_applicable", detectedUrls: [],
    exitCode: 0, waitTimedOut: false, outputTruncated: false, outputCursor: 0, interaction: { state: "none" }, pinned: false,
    startedAt: new Date(0).toISOString(), readyAt: new Date(10).toISOString(), finishedAt: new Date(25).toISOString(), ...overrides
  };
}

test("聚合生命周期、延迟、截断和后台活动指标", () => {
  const metrics = new CommandExecutionMetrics();
  const finished = execution();
  metrics.recordStarted();
  metrics.recordReady(finished);
  metrics.recordFinished(finished);
  metrics.recordWaitTimeout();
  metrics.recordOutputTruncated();
  const snapshot = metrics.snapshot([execution({ id: "active", mode: "background", state: "running", finishedAt: undefined })]);
  assert.equal(snapshot.command_execution_started_total, 1);
  assert.equal(snapshot.command_execution_finished_total.succeeded, 1);
  assert.equal(snapshot.command_execution_ready_latency_ms.total, 10);
  assert.equal(snapshot.command_execution_duration_ms.total, 25);
  assert.equal(snapshot.command_execution_active_background, 1);
});
