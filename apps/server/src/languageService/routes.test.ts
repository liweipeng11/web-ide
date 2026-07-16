import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { LanguageServiceGateway } from "../contracts/languageService.js";
import { HttpError } from "../errors.js";
import { deletePendingPatch, getPendingPatch } from "../patchStore.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createLanguageServiceRouter } from "./routes.js";

test("language service routes expose code actions and convert rename into a pending patch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-language-routes-"));
  await fs.writeFile(path.join(root, "main.ts"), "const oldName = 1;\n", "utf8");
  await setWorkspaceRoot(root, { persist: false });
  const gateway: LanguageServiceGateway = {
    async getCapabilities() { return { languageId: "typescript", diagnostics: true, definition: true, references: true, hover: true, workspaceSymbols: true, codeActions: true, rename: true, source: "lsp", available: true, degraded: false }; },
    async syncDocument() {},
    async getDiagnostics() { return []; },
    async findDefinition() { return []; },
    async findReferences() { return []; },
    async listWorkspaceSymbols() { return []; },
    async getHover() { return null; },
    async getCodeActions(filePath, range) { return [{ title: "Use suggested fix", diagnostics: [{ filePath, range, severity: "warning", message: "fix me", source: "lsp" }], edit: { source: "lsp", changes: { "main.ts": [{ range: { start: { line: 1, column: 7 }, end: { line: 1, column: 14 } }, newText: "fixedName" }] } }, source: "lsp" }]; },
    async rename() { return { source: "lsp", changes: { "main.ts": [{ range: { start: { line: 1, column: 7 }, end: { line: 1, column: 14 } }, newText: "newName" }] } }; }
  };
  const app = express();
  app.use(express.json());
  app.use("/api", createLanguageServiceRouter(gateway));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : "error" }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api/language-service`;
  const patchIds: string[] = [];
  try {
    const actionResponse = await fetch(`${baseUrl}/code-actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filePath: "main.ts", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 10 } } }) });
    assert.equal(actionResponse.status, 200);
    const action = (await actionResponse.json() as { actions: Array<{ title: string; edit: unknown }> }).actions[0];
    assert.equal(action.title, "Use suggested fix");
    const actionPatchResponse = await fetch(`${baseUrl}/workspace-edit/patch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ edit: action.edit, summary: action.title }) });
    assert.equal(actionPatchResponse.status, 200);
    const actionPatch = await actionPatchResponse.json() as { patch: { patchId: string } };
    patchIds.push(actionPatch.patch.patchId);
    assert.equal(getPendingPatch(actionPatch.patch.patchId)?.files[0].newContent, "const fixedName = 1;\n");

    const renameResponse = await fetch(`${baseUrl}/rename`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ location: { filePath: "main.ts", line: 1, column: 7 }, newName: "newName" }) });
    assert.equal(renameResponse.status, 200);
    const rename = await renameResponse.json() as { patch: { patchId: string } };
    patchIds.push(rename.patch.patchId);
    assert.equal(getPendingPatch(rename.patch.patchId)?.files[0].newContent, "const newName = 1;\n");
    assert.equal(await fs.readFile(path.join(root, "main.ts"), "utf8"), "const oldName = 1;\n");
  } finally {
    for (const patchId of patchIds) deletePendingPatch(patchId);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});
