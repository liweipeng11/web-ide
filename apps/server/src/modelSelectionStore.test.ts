import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { readModelDefaults, writeModelDefaults } from "./modelSelectionStore.js";

test("模型默认值持久化后可恢复且文件不包含密钥", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-selection-"));
  const originalDirectory = config.stateDirectory;
  const originalKey = config.aiApiKey;
  const originalModels = config.aiModels;
  const modelId = "persisted-model";
  config.stateDirectory = directory;
  config.aiApiKey = "never-write-this-key";
  config.aiModels = [modelId];
  const defaults = {
    chat: { providerId: "openai-compatible", modelId },
    plan: { providerId: "openai-compatible", modelId },
    act: { providerId: "openai-compatible", modelId }
  };
  try {
    await writeModelDefaults(defaults);
    assert.deepEqual(await readModelDefaults(), defaults);
    const raw = await fs.readFile(path.join(directory, "model-preferences.json"), "utf8");
    assert.equal(raw.includes(config.aiApiKey), false);
    assert.equal(raw.includes("Authorization"), false);
  } finally {
    config.stateDirectory = originalDirectory;
    config.aiApiKey = originalKey;
    config.aiModels = originalModels;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
