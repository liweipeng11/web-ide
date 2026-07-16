import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LspProcessManager } from "./lspProcessManager.js";

const fakeServerSource = String.raw`
const fs = require("node:fs");
let buffer = Buffer.alloc(0);
const logPath = process.argv[2];
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n"), body]));
}
function log(value) { fs.appendFileSync(logPath, JSON.stringify(value) + "\n"); }
function dispatch(message) {
  if (message.method === "initialize") return send({ jsonrpc: "2.0", id: message.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, workspaceSymbolProvider: true, codeActionProvider: true, renameProvider: true, textDocumentSync: 1 } } });
  if (message.method === "shutdown") return send({ jsonrpc: "2.0", id: message.id, result: null });
  if (message.method === "exit") return process.exit(0);
  if (message.method === "test/crash") return process.exit(17);
  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
    log({ method: message.method, params: message.params });
    const document = message.params.textDocument;
    return send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: document.uri, version: document.version, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "fake diagnostic" }] } });
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: null });
}
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i)?.[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString();
    buffer = buffer.subarray(end + 4 + length);
    dispatch(JSON.parse(body));
  }
});
`;

test("process manager restarts a crashed server and replays unsaved documents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-process-"));
  const scriptPath = path.join(root, "fake-lsp.cjs");
  const logPath = path.join(root, "fake-lsp.log");
  await fs.writeFile(scriptPath, fakeServerSource, "utf8");
  const diagnostics: unknown[] = [];
  const manager = new LspProcessManager({
    idleTimeoutMs: 60_000,
    discover: async () => ({ family: "typescript", command: process.execPath, args: [scriptPath, logPath] }),
    onDiagnostics: (value) => diagnostics.push(value)
  });

  await manager.syncDocument(root, { filePath: "main.ts", content: "const unsaved = true;\n", version: 3, action: "open" });
  const first = await manager.getServer(root, "typescript");
  await assert.rejects(first!.request("test/crash", null), /closed|exited/i);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const restarted = await manager.getServer(root, "typescript");
  assert.ok(restarted);
  await new Promise((resolve) => setTimeout(resolve, 80));

  const entries = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { method: string; params: { textDocument: { version: number; text: string } } });
  const opens = entries.filter((entry) => entry.method === "textDocument/didOpen");
  assert.equal(opens.length, 2);
  assert.equal(opens[1].params.textDocument.version, 3);
  assert.equal(opens[1].params.textDocument.text, "const unsaved = true;\n");
  assert.ok(diagnostics.length >= 2);
  await manager.disposeWorkspace(root);
  await manager.disposeAll();
  await fs.rm(root, { recursive: true, force: true });
});

test("process manager isolates TypeScript, Vue and Python server families", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-languages-"));
  const scriptPath = path.join(root, "fake-lsp.cjs");
  const logPath = path.join(root, "fake-lsp.log");
  await fs.writeFile(scriptPath, fakeServerSource, "utf8");
  const diagnostics: unknown[] = [];
  const manager = new LspProcessManager({
    idleTimeoutMs: 60_000,
    discover: async (_workspaceRoot, languageId) => ({
      family: languageId === "python" ? "python" : languageId === "vue" ? "vue" : "typescript",
      command: process.execPath,
      args: [scriptPath, logPath]
    }),
    onDiagnostics: (value) => diagnostics.push(value)
  });
  await Promise.all([
    manager.syncDocument(root, { filePath: "main.ts", content: "const value = 1;\n", version: 1, action: "open" }),
    manager.syncDocument(root, { filePath: "Panel.vue", content: "<template><div /></template>\n", version: 1, action: "open" }),
    manager.syncDocument(root, { filePath: "main.py", content: "value = 1\n", version: 1, action: "open" })
  ]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const entries = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { method: string });
  assert.equal(entries.filter((entry) => entry.method === "textDocument/didOpen").length, 3);
  assert.equal(diagnostics.length, 3);
  await manager.disposeAll();
  await fs.rm(root, { recursive: true, force: true });
});

test("closing a document while its server is down prevents stale replay", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-close-"));
  const scriptPath = path.join(root, "fake-lsp.cjs");
  const logPath = path.join(root, "fake-lsp.log");
  await fs.writeFile(scriptPath, fakeServerSource, "utf8");
  const manager = new LspProcessManager({ discover: async () => ({ family: "typescript", command: process.execPath, args: [scriptPath, logPath] }) });
  await manager.syncDocument(root, { filePath: "main.ts", content: "const stale = true;\n", version: 1, action: "open" });
  const server = await manager.getServer(root, "typescript");
  await assert.rejects(server!.request("test/crash", null));
  await new Promise((resolve) => setTimeout(resolve, 80));
  await manager.syncDocument(root, { filePath: "main.ts", version: 1, action: "close" });
  await manager.getServer(root, "typescript");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const entries = (await fs.readFile(logPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { method: string });
  assert.equal(entries.filter((entry) => entry.method === "textDocument/didOpen").length, 1);
  await manager.disposeAll();
  await fs.rm(root, { recursive: true, force: true });
});

test("language server stderr redaction removes credentials", async () => {
  const manager = new LspProcessManager();
  const redact = (manager as unknown as { redactLog(value: string): string }).redactLog.bind(manager);
  const value = redact("Authorization: Bearer top-secret API_KEY=another-secret password=hunter2");
  assert.equal(value.includes("top-secret"), false);
  assert.equal(value.includes("another-secret"), false);
  assert.equal(value.includes("hunter2"), false);
  await manager.disposeAll();
});
