import assert from "node:assert/strict";
import test from "node:test";
import { CommandExecutionService } from "./commandExecutionService.js";
import type { CommandProcessFactory, CommandProcessListeners } from "./commandProcess.js";
import type { CommandExecutionEvent } from "./types.js";

type Scenario = (listeners: CommandProcessListeners) => void;

function createHarness(scenario: Scenario, maxOutputLength = 80_000) {
  let killed = false;
  const factory: CommandProcessFactory = {
    start(_options, listeners) {
      queueMicrotask(() => scenario(listeners));
      return { pid: 4321, kill: () => (killed = true) };
    }
  };
  const service = new CommandExecutionService({ processFactory: factory, maxOutputLength, createId: () => "cmd-test" });
  return { service, wasKilled: () => killed };
}

test("exit 0 使用真实退出事件进入 succeeded", async () => {
  const { service } = createHarness((listeners) => listeners.onExit(0));
  const started = await service.start({ command: "node fixture exit 0", cwd: process.cwd() });
  const finished = await service.waitForState(started.id);
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.exitCode, 0);
});

test("非零退出码进入 failed 并保留原因", async () => {
  const { service } = createHarness((listeners) => listeners.onExit(7));
  const started = await service.start({ command: "node fixture exit 7", cwd: process.cwd() });
  const finished = await service.waitForState(started.id);
  assert.equal(finished.state, "failed");
  assert.equal(finished.exitCode, 7);
  assert.equal(finished.failureReason, "non_zero_exit");
});

test("长期命令检测到本地 URL 后进入 ready 但进程仍运行", async () => {
  const { service } = createHarness((listeners) => listeners.onData("stdout", "ready at http://localhost:18080\n"));
  const started = await service.start({ command: "npm run serve", cwd: process.cwd(), mode: "background" });
  const ready = await service.waitForState(started.id, { until: "ready_or_finished", timeoutMs: 100 });
  assert.equal(ready.state, "running");
  assert.equal(ready.readiness, "ready");
  assert.equal(ready.readyUrl, "http://localhost:18080");
});

test("等待超时只停止同步等待，默认不终止进程", async () => {
  const { service, wasKilled } = createHarness(() => undefined);
  const started = await service.start({ command: "npm run serve", cwd: process.cwd() });
  const snapshot = await service.waitForState(started.id, { until: "ready_or_finished", timeoutMs: 5 });
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.waitTimedOut, true);
  assert.equal(wasKilled(), false);
});

test("运行中命令转入后台后可基于已有输出立即标记 ready", async () => {
  const { service } = createHarness((listeners) => listeners.onData("stdout", "Local: http://localhost:4100\n"));
  const started = await service.start({ command: "node custom-server.js", cwd: process.cwd(), mode: "foreground" });
  await new Promise((resolve) => setImmediate(resolve));
  const background = await service.moveToBackground(started.id);
  assert.equal(background.mode, "background");
  assert.equal(background.readiness, "ready");
  assert.equal(background.readyUrl, "http://localhost:4100");
});

test("执行超时终止进程并记录 execution_timeout", async () => {
  const { service, wasKilled } = createHarness(() => undefined);
  const started = await service.start({ command: "node fixture sleep 500", cwd: process.cwd(), executionTimeoutMs: 5 });
  const finished = await service.waitForState(started.id);
  assert.equal(finished.state, "failed");
  assert.equal(finished.failureReason, "execution_timeout");
  assert.equal(wasKilled(), true);
});

test("重复 stop 和迟到 exit 只产生一次 finished 事件", async () => {
  let processListeners: CommandProcessListeners | undefined;
  const { service, wasKilled } = createHarness((listeners) => {
    processListeners = listeners;
  });
  const events: CommandExecutionEvent[] = [];
  service.subscribe((event) => events.push(event));
  const started = await service.start({ command: "node fixture silent-server", cwd: process.cwd() });
  await new Promise((resolve) => setImmediate(resolve));
  const first = await service.stop(started.id);
  const second = await service.stop(started.id);
  processListeners?.onExit(0);
  assert.equal(first.state, "cancelled");
  assert.equal(second.state, "cancelled");
  assert.equal(wasKilled(), true);
  assert.equal(events.filter((event) => event.type === "finished").length, 1);
});

test("大输出受内存上限约束并支持增量补拉", async () => {
  const { service } = createHarness((listeners) => {
    listeners.onData("stdout", "a".repeat(100));
    listeners.onExit(0);
  }, 20);
  const started = await service.start({ command: "node fixture spam 100", cwd: process.cwd() });
  const finished = await service.waitForState(started.id);
  const output = await service.readOutput(started.id, 0);
  assert.equal(finished.outputTruncated, true);
  assert.equal(output.data.length, 20);
  assert.equal(output.truncated, true);
  assert.equal(output.nextCursor, 100);
});

test("spawn error 稳定映射为 failed", async () => {
  const factory: CommandProcessFactory = {
    start() {
      throw new Error("spawn failed");
    }
  };
  const service = new CommandExecutionService({ processFactory: factory, createId: () => "cmd-error" });
  const execution = await service.start({ command: "missing-command", cwd: process.cwd() });
  assert.equal(execution.state, "failed");
  assert.equal(execution.failureReason, "spawn_error");
});

test("Agent 环境、Shell 能力和 CI 策略传递给进程层", async () => {
  let received: Parameters<CommandProcessFactory["start"]>[0] | undefined;
  const processFactory: CommandProcessFactory = {
    start(options, listeners) {
      received = options;
      queueMicrotask(() => listeners.onExit(0));
      return { pid: 11, kill: () => true };
    }
  };
  const service = new CommandExecutionService({ processFactory, createId: () => "cmd-env" });
  const started = await service.start({ command: "npm test", cwd: process.cwd(), initiator: "validation", ci: true });
  await service.waitForState(started.id);
  assert.equal(received?.env?.MINI_AI_AGENT, "1");
  assert.equal(received?.env?.CI, "1");
  assert.ok(started.shell.name);
  assert.notEqual(started.shell.capability, "none");
});

test("敏感交互使用独立状态表达，模型摘要不包含敏感值", async () => {
  const { service } = createHarness((listeners) => listeners.onData("stdout", "Password: hunter2\nPassword: "));
  const events: CommandExecutionEvent[] = [];
  service.subscribe((event) => events.push(event));
  const started = await service.start({ command: "login-tool", cwd: process.cwd(), initiator: "agent" });
  const current = await service.waitForState(started.id, { timeoutMs: 100 });
  const summary = await service.getOutputSummary(started.id);
  assert.equal(current?.interaction.state, "needs_input");
  assert.equal(current?.interaction.kind, "password");
  assert.equal(events.filter((event) => event.type === "interaction").length, 1);
  assert.doesNotMatch(summary.output, /hunter2/);
});

test("shutdown 回收未固定活动任务但保留固定任务", async () => {
  let killed = 0;
  let sequence = 0;
  const processFactory: CommandProcessFactory = {
    start() { return { pid: ++sequence, kill: () => { killed += 1; return true; } }; }
  };
  const service = new CommandExecutionService({ processFactory, createId: () => `cmd-shutdown-${sequence + 1}` });
  const disposable = await service.start({ command: "npm run dev", cwd: process.cwd(), mode: "background" });
  const retained = await service.start({ command: "npm run watch", cwd: process.cwd(), mode: "background" });
  await service.setPinned(retained.id, true);
  await service.shutdown();
  assert.equal((await service.get(disposable.id))?.state, "cancelled");
  assert.equal((await service.get(retained.id))?.state, "running");
  assert.equal(killed, 1);
});
