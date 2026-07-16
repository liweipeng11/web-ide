import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { JsonRpcConnection } from "./jsonRpcConnection.js";

function frame(value: unknown) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

test("JsonRpcConnection handles split LSP frames and notifications", async () => {
  const serverOutput = new PassThrough();
  const clientOutput = new PassThrough();
  const notifications: Array<{ method: string; params: unknown }> = [];
  const connection = new JsonRpcConnection(serverOutput, clientOutput, { onNotification: (method, params) => notifications.push({ method, params }) });
  const chunks: Buffer[] = [];
  clientOutput.on("data", (chunk: Buffer) => chunks.push(chunk));

  const pending = connection.request<{ ok: boolean }>("example/read", { value: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const requestText = Buffer.concat(chunks).toString("utf8");
  const id = Number(requestText.match(/"id":(\d+)/)?.[1]);
  assert.equal(Number.isInteger(id), true);

  const response = frame({ jsonrpc: "2.0", id, result: { ok: true } });
  serverOutput.write(response.subarray(0, 12));
  serverOutput.write(response.subarray(12));
  assert.deepEqual(await pending, { ok: true });

  serverOutput.write(frame({ jsonrpc: "2.0", method: "example/notice", params: { active: true } }));
  assert.deepEqual(notifications, [{ method: "example/notice", params: { active: true } }]);
  connection.close();
});

test("JsonRpcConnection rejects invalid oversized frames", async () => {
  const serverOutput = new PassThrough();
  const clientOutput = new PassThrough();
  const connection = new JsonRpcConnection(serverOutput, clientOutput);
  const pending = connection.request("example/read", {});
  serverOutput.write("Content-Length: 999999999\r\n\r\n");
  await assert.rejects(pending, /Invalid language server message length/);
});

