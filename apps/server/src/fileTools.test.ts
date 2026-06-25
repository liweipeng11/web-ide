import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listFiles } from "./fileTools.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

function flattenTreePaths(nodes: Awaited<ReturnType<typeof listFiles>>) {
  const paths: string[] = [];

  for (const node of nodes) {
    paths.push(node.path);

    if (node.type === "directory") {
      paths.push(...flattenTreePaths(node.children || []));
    }
  }

  return paths;
}

test("expands mini-ai runtime logs only when generated files are included", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-file-tree-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, ".mini-ai", "state", "runtime", "ai-logs"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, ".mini-ai", "rules"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".mini-ai", "AGENTS.md"), "# Agent rules\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, ".mini-ai", "state", "runtime", "ai-logs", "exchange.json"), "{}\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const defaultPaths = flattenTreePaths(await listFiles(""));
    assert.ok(defaultPaths.includes(".mini-ai"));
    assert.ok(defaultPaths.includes(".mini-ai/AGENTS.md"));
    assert.ok(!defaultPaths.includes(".mini-ai/state"));
    assert.ok(!defaultPaths.includes(".mini-ai/state/runtime/ai-logs/exchange.json"));

    const generatedPaths = flattenTreePaths(await listFiles("", true));
    assert.ok(generatedPaths.includes(".mini-ai/state"));
    assert.ok(generatedPaths.includes(".mini-ai/state/runtime/ai-logs/exchange.json"));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
