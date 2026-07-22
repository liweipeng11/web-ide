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
    initiator: "user", shell: { name: "test", capability: "basic" }, interaction: { state: "none" }, pinned: false,
    readiness: "pending", detectedUrls: [], exitCode: null, waitTimedOut: false,
    outputTruncated: false, outputCursor: 0, startedAt: new Date().toISOString()
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

test("清理策略保留活动和固定任务，并限制普通历史与单日志体积", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-cleanup-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CommandExecutionStore({
    stateFilePath: path.join(root, "executions.json"), outputDirectory: path.join(root, "output"),
    retentionLimit: 1, retentionDays: 30, maxLogFileBytes: 5, maxWorkspaceLogBytes: 10
  });
  await store.upsert({ ...execution("succeeded"), id: "old", finishedAt: new Date().toISOString() });
  await store.upsert({ ...execution("succeeded"), id: "new", finishedAt: new Date(Date.now() + 1).toISOString() });
  await store.upsert({ ...execution("running"), id: "active" });
  await store.upsert({ ...execution("succeeded"), id: "pinned", pinned: true });
  await store.appendOutput("new", "123456789");
  assert.equal((await store.readOutput("new")).data, "12345");
  await store.cleanup();
  const document = JSON.parse(await fs.readFile(path.join(root, "executions.json"), "utf8")) as { executions: CommandExecution[] };
  const ids = document.executions.map((item) => item.id);
  assert.equal(ids.includes("old"), false);
  assert.equal(ids.includes("new"), true);
  assert.equal(ids.includes("active"), true);
  assert.equal(ids.includes("pinned"), true);
});
