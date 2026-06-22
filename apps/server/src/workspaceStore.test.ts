import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { initializeWorkspaceRoot, setWorkspaceRoot } from "./workspaceStore.js";

async function createTempDirectory(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("persists workspace root only when persistence is enabled", async () => {
  const stateRoot = await createTempDirectory("mini-ai-workspace-state-");
  const firstWorkspace = await createTempDirectory("mini-ai-workspace-first-");
  const secondWorkspace = await createTempDirectory("mini-ai-workspace-second-");
  const previousStateFilePath = config.stateFilePath;
  const previousLegacyStateFilePath = config.legacyStateFilePath;
  config.stateFilePath = path.join(stateRoot, "state.json");
  config.legacyStateFilePath = path.join(stateRoot, "legacy-state.json");

  try {
    await setWorkspaceRoot(firstWorkspace);
    assert.deepEqual(JSON.parse(await fs.readFile(config.stateFilePath, "utf8")), { workspaceRoot: firstWorkspace });

    await setWorkspaceRoot(secondWorkspace, { persist: false });
    assert.deepEqual(JSON.parse(await fs.readFile(config.stateFilePath, "utf8")), { workspaceRoot: firstWorkspace });

    await initializeWorkspaceRoot();
    assert.deepEqual(JSON.parse(await fs.readFile(config.stateFilePath, "utf8")), { workspaceRoot: firstWorkspace });
  } finally {
    // 测试会临时替换状态文件路径，结束后必须恢复，避免影响其它用例和真实应用。
    config.stateFilePath = previousStateFilePath;
    config.legacyStateFilePath = previousLegacyStateFilePath;
  }
});
