import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverLanguageServer, languageFamily } from "./serverDiscovery.js";

test("language server discovery uses a fixed executable and argument array", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-lsp-discovery-"));
  const packageRoot = path.join(root, "node_modules", "typescript-language-server");
  await fs.mkdir(path.join(packageRoot, "lib"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ bin: { "typescript-language-server": "lib/cli.js" } }), "utf8");
  await fs.writeFile(path.join(packageRoot, "lib", "cli.js"), "", "utf8");

  const launch = await discoverLanguageServer(root, "typescript");
  assert.equal(launch?.command, process.execPath);
  assert.deepEqual(launch?.args, [path.join(packageRoot, "lib", "cli.js"), "--stdio"]);
  assert.equal(languageFamily("../../malicious;command"), null);
  await fs.rm(root, { recursive: true, force: true });
});

