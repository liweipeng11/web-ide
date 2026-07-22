import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { attachTerminalServer } from "../terminalServer.js";
import { CommandExecutionService } from "./commandExecutionService.js";
import type { CommandProcessFactory, CommandProcessListeners } from "./commandProcess.js";

function createHarness() {
  let listeners: CommandProcessListeners | undefined;
  const processFactory: CommandProcessFactory = {
    start(_options, nextListeners) {
      listeners = nextListeners;
      return { pid: 4321, kill: () => true };
    }
  };
  return { service: new CommandExecutionService({ processFactory, createId: () => "cmd-ws" }), listeners: () => listeners };
}

async function openSocket(url: string) {
  const socket = new WebSocket(url);
  const messages: any[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString("utf8"))));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, messages };
}

async function waitFor(messages: any[], predicate: (message: any) => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = messages.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for WebSocket message");
}

test("WebSocket execution 协议支持事件订阅、断线 cursor 补拉与停止", async (context) => {
  const harness = createHarness();
  const server = http.createServer();
  attachTerminalServer(server, { executionService: harness.service, createTerminal: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  const url = `ws://127.0.0.1:${address.port}/terminal`;
  const execution = await harness.service.start({ command: "node server", cwd: process.cwd() });

  const first = await openSocket(url);
  first.socket.send(JSON.stringify({ type: "command.subscribe", id: execution.id, cursor: 0 }));
  await waitFor(first.messages, (message) => message.type === "command.started");
  harness.listeners()?.onData("stdout", "hello");
  const hello = await waitFor(first.messages, (message) => message.type === "command.output");
  assert.equal(hello.data, "hello");
  first.socket.close();
  await new Promise((resolve) => first.socket.once("close", resolve));

  harness.listeners()?.onData("stdout", " world");
  const second = await openSocket(url);
  second.socket.send(JSON.stringify({ type: "command.subscribe", id: execution.id, cursor: 5 }));
  const recovered = await waitFor(second.messages, (message) => message.type === "command.output");
  assert.equal(recovered.cursor, 5);
  assert.equal(recovered.data, " world");
  second.socket.send(JSON.stringify({ type: "command.stop", id: execution.id }));
  const finished = await waitFor(second.messages, (message) => message.type === "command.finished");
  assert.equal(finished.execution.state, "cancelled");
  second.socket.close();
  await new Promise((resolve) => second.socket.once("close", resolve));
});
