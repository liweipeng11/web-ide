import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { DefaultLanguageServiceGateway } from "./languageServiceGateway.js";
import type { LspProcessManager, PublishedDiagnostics } from "./lspProcessManager.js";

test("gateway falls back to Symbol Graph and keeps source/completeness", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-language-gateway-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "service.ts"), "export function loadUser() { return true }\n", "utf8");
  await fs.writeFile(path.join(root, "src", "view.ts"), "import { loadUser } from './service.js'\nloadUser()\n", "utf8");
  await setWorkspaceRoot(root, { persist: false });
  const gateway = new DefaultLanguageServiceGateway({ enabled: () => false });

  const capability = await gateway.getCapabilities("src/view.ts");
  assert.equal(capability.degraded, true);
  assert.equal(capability.source, "symbol_graph");
  const definitions = await gateway.findDefinition({ filePath: "src/view.ts", line: 2, column: 2 });
  assert.equal(definitions[0]?.filePath, "src/service.ts");
  assert.equal(definitions[0]?.source, "symbol_graph");
  assert.equal(definitions[0]?.complete, false);
  await gateway.disposeAll();
  await fs.rm(root, { recursive: true, force: true });
});

test("gateway discards diagnostics published for an old document version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-language-version-"));
  await fs.writeFile(path.join(root, "main.ts"), "const value = 1\n", "utf8");
  await setWorkspaceRoot(root, { persist: false });
  const gateway = new DefaultLanguageServiceGateway({ enabled: () => false });
  await gateway.syncDocument({ filePath: "main.ts", content: "const value = 2\n", version: 2, action: "open" });
  const accept = (gateway as unknown as { acceptDiagnostics(value: PublishedDiagnostics): void }).acceptDiagnostics.bind(gateway);
  const uri = new URL(`file:///${path.join(root, "main.ts").replace(/\\/g, "/")}`).toString();
  accept({ uri, version: 1, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "old" }] });
  assert.deepEqual(await gateway.getDiagnostics("main.ts", 2), []);
  accept({ uri, version: 2, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, severity: 1, message: "current" }] });
  assert.equal((await gateway.getDiagnostics("main.ts", 2))[0]?.message, "current");
  await gateway.disposeAll();
  await fs.rm(root, { recursive: true, force: true });
});

test("gateway aggregates workspace symbols from every language server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-language-symbols-"));
  await setWorkspaceRoot(root, { persist: false });
  const manager = {
    async getServer(_workspaceRoot: string, languageId: string) {
      return {
        family: languageId === "python" ? "python" : languageId === "vue" ? "vue" : "typescript",
        capabilities: { workspaceSymbolProvider: true },
        async request() {
          return [{ name: `${languageId}Symbol`, kind: 12, location: { uri: pathToFileURL(path.join(root, `${languageId}.txt`)).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } }];
        },
        notify() {}
      };
    },
    async disposeWorkspace() {},
    async disposeAll() {}
  } as unknown as LspProcessManager;
  const gateway = new DefaultLanguageServiceGateway({ enabled: () => true, manager });
  const symbols = await gateway.listWorkspaceSymbols("Symbol");
  assert.deepEqual(symbols.map((symbol) => symbol.name).sort(), ["pythonSymbol", "typescriptSymbol", "vueSymbol"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("gateway normalizes documentChanges and requests real LSP code actions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-language-actions-"));
  await fs.writeFile(path.join(root, "main.ts"), "const oldName = 1;\n", "utf8");
  await setWorkspaceRoot(root, { persist: false });
  const uri = pathToFileURL(path.join(root, "main.ts")).toString();
  const manager = {
    async getServer() {
      return {
        family: "typescript",
        capabilities: { renameProvider: true, codeActionProvider: true },
        async request(method: string) {
          const edit = { documentChanges: [{ textDocument: { uri }, edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "newName" }] }] };
          return method === "textDocument/codeAction" ? [{ title: "Rename safely", kind: "quickfix", edit }] : edit;
        },
        notify() {}
      };
    },
    async disposeWorkspace() {},
    async disposeAll() {}
  } as unknown as LspProcessManager;
  const gateway = new DefaultLanguageServiceGateway({ enabled: () => true, manager });
  const edit = await gateway.rename({ filePath: "main.ts", line: 1, column: 7 }, "newName");
  assert.equal(edit.changes["main.ts"][0].newText, "newName");
  const actions = await gateway.getCodeActions("main.ts", { start: { line: 1, column: 1 }, end: { line: 1, column: 14 } });
  assert.equal(actions[0]?.title, "Rename safely");
  assert.equal(actions[0]?.edit?.changes["main.ts"][0].newText, "newName");
  await fs.rm(root, { recursive: true, force: true });
});

test("python locations fall back to bounded text search when LSP is unavailable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-language-text-"));
  await fs.writeFile(path.join(root, "main.py"), "def load_user():\n    return True\n\nload_user()\n", "utf8");
  await setWorkspaceRoot(root, { persist: false });
  const gateway = new DefaultLanguageServiceGateway({ enabled: () => false });
  const definitions = await gateway.findDefinition({ filePath: "main.py", line: 4, column: 3 });
  const references = await gateway.findReferences({ filePath: "main.py", line: 4, column: 3 });
  assert.equal(definitions[0]?.line, 1);
  assert.equal(definitions[0]?.source, "text_search");
  assert.equal(references.length, 2);
  await gateway.disposeAll();
  await fs.rm(root, { recursive: true, force: true });
});
