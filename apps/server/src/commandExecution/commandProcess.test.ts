import assert from "node:assert/strict";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { childProcessFactory } from "./commandProcess.js";
import { CommandExecutionService } from "./commandExecutionService.js";

async function reservePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("真实子进程输出和退出码通过统一抽象回传", async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "testCommandProcess.ts");
  const command = `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(fixture)} output 3`;
  let stdout = "";

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    childProcessFactory.start(
      { command, cwd: process.cwd(), env: process.env },
      {
        onData(stream, data) {
          if (stream === "stdout") stdout += data;
        },
        onExit: resolve,
        onError: reject
      }
    );
  });

  assert.equal(exitCode, 0);
  assert.match(stdout, /line-0/);
  assert.match(stdout, /line-2/);
});

test("真实后台服务 ready 后可主动停止并释放端口", async () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "testCommandProcess.ts");
  const port = await reservePort();
  const command = `${JSON.stringify(process.execPath)} --import tsx ${JSON.stringify(fixture)} server ${port}`;
  const service = new CommandExecutionService();
  const started = await service.start({ command, cwd: process.cwd(), mode: "background" });
  const ready = await service.waitForState(started.id, { until: "ready_or_finished", timeoutMs: 10_000 });
  assert.equal(ready.state, "running");
  assert.equal(ready.readiness, "ready");
  assert.match(await (await fetch(`http://127.0.0.1:${port}`)).text(), /ready/);

  const stopped = await service.stop(started.id);
  assert.equal(stopped.state, "cancelled");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  assert.fail("后台服务停止后端口仍被占用");
});
