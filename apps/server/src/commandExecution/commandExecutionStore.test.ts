import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CommandExecutionStore } from "./commandExecutionStore.js";
import type { CommandExecution } from "./types.js";

function execution(state: CommandExecution["state"] = "running"): CommandExecution {
  return {
    id: "cmd-store", command: "npm run dev", cwd: process.cwd(), mode: "background", state,
    readiness: "pending", detectedUrls: [], exitCode: null, waitTimedOut: false,
    outputTruncated: false, outputCursor: 0, startedAt: new Date(0).toISOString()
  };
}

test("元数据不包含日志正文，日志支持 cursor 增量读取", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-store-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateFilePath = path.join(root, "command-executions.json");
  const store = new CommandExecutionStore({ stateFilePath, outputDirectory: path.join(root, "command-output") });
  await store.upsert(execution("succeeded"));
  await store.appendOutput("cmd-store", "hello world");
  assert.doesNotMatch(await fs.readFile(stateFilePath, "utf8"), /hello world/);
  assert.equal((await store.readOutput("cmd-store", 6)).data, "world");
});

test("重启加载时将失联 running 记录标记为 server_restart", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-restart-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { stateFilePath: path.join(root, "command-executions.json"), outputDirectory: path.join(root, "command-output"), now: () => new Date(5) };
  const first = new CommandExecutionStore(options);
  await first.upsert(execution());
  const loaded = await new CommandExecutionStore(options).load();
  assert.equal(loaded[0].state, "failed");
  assert.equal(loaded[0].failureReason, "server_restart");
  assert.equal(loaded[0].finishedAt, new Date(5).toISOString());
});
