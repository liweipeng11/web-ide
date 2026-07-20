import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLanguageServer, languageFamily } from "./serverDiscovery.js";

async function createNodeLanguageServer(root: string, packageName: string, command: string) {
  const packageRoot = path.join(root, "node_modules", ...packageName.split("/"));
  const binPath = path.join(packageRoot, "lib", "cli.js");
  await fs.mkdir(path.dirname(binPath), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ bin: { [command]: "lib/cli.js" } }), "utf8");
  await fs.writeFile(binPath, "", "utf8");
  return binPath;
}

test("language server discovery uses a fixed executable and argument array", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-discovery-"));
  const binPath = await createNodeLanguageServer(root, "typescript-language-server", "typescript-language-server");

  const launch = await discoverLanguageServer(root, "typescript", { builtInRoot: path.join(root, "missing"), pathValue: "" });
  assert.equal(launch?.command, process.execPath);
  assert.deepEqual(launch?.args, [binPath, "--stdio"]);
  assert.equal(languageFamily("../../malicious;command"), null);
  await fs.rm(root, { recursive: true, force: true });
});

test("language server discovery falls back to the Web IDE built-in dependency", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-built-in-"));
  const workspaceRoot = path.join(root, "workspace");
  const builtInRoot = path.join(root, "server");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const binPath = await createNodeLanguageServer(builtInRoot, "@vue/language-server", "vue-language-server");

  const launch = await discoverLanguageServer(workspaceRoot, "vue", { builtInRoot, pathValue: "" });

  assert.equal(launch?.command, process.execPath);
  assert.deepEqual(launch?.args, [binPath, "--stdio"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("any workspace Python server takes priority over built-in candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-priority-"));
  const workspaceRoot = path.join(root, "workspace");
  const builtInRoot = path.join(root, "server");
  const workspaceBin = await createNodeLanguageServer(workspaceRoot, "pyright", "pyright-langserver");
  await createNodeLanguageServer(builtInRoot, "basedpyright", "basedpyright-langserver");

  const launch = await discoverLanguageServer(workspaceRoot, "python", { builtInRoot, pathValue: "" });

  assert.equal(launch?.command, process.execPath);
  assert.deepEqual(launch?.args, [workspaceBin, "--stdio"]);
  await fs.rm(root, { recursive: true, force: true });
});
