import assert from "node:assert/strict";
import test from "node:test";
import { createCommandOutputSummary } from "./commandOutputSummary.js";
import type { CommandExecution } from "./types.js";

const execution: CommandExecution = {
  id: "cmd-summary", command: "npm test", cwd: process.cwd(), mode: "foreground", state: "failed",
  readiness: "not_applicable", detectedUrls: [], exitCode: 1, waitTimedOut: false,
  outputTruncated: false, outputCursor: 0, startedAt: new Date(0).toISOString()
};

test("摘要压缩重复行并保留输出尾部", () => {
  const result = createCommandOutputSummary(execution, `progress\nprogress\nprogress\nERROR compile failed\n${"x".repeat(100)}\nfinal`, 70);
  assert.equal(result.truncated, true);
  assert.match(result.output, /ERROR compile failed/);
  assert.match(result.output, /final$/);
  assert.match(result.summary, /截断/);
});

test("就绪服务摘要包含 ready URL", () => {
  const result = createCommandOutputSummary({ ...execution, state: "running", readiness: "ready", readyUrl: "http://localhost:3000" }, "ready");
  assert.match(result.summary, /localhost:3000/);
});
