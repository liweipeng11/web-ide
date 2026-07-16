import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { createModelRouter } from "./modelRoutes.js";

test("模型目录 API 返回脱敏能力并支持更新三类默认值", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-routes-"));
  const originalDirectory = config.stateDirectory;
  const originalKey = config.aiApiKey;
  const originalModels = config.aiModels;
  const modelId = "route-model";
  config.stateDirectory = directory;
  config.aiApiKey = "route-secret-key";
  config.aiModels = [modelId];
  const app = express();
  app.use(express.json());
  app.use("/api", createModelRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    const catalogResponse = await fetch(`${baseUrl}/models`);
    const catalogText = await catalogResponse.text();
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogText.includes(config.aiApiKey), false);
    assert.equal(/Authorization|Bearer|apiKey/i.test(catalogText), false);
    const selection = { providerId: "openai-compatible", modelId };
    const updateResponse = await fetch(`${baseUrl}/models/defaults`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat: selection, plan: selection, act: selection }) });
    assert.equal(updateResponse.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    config.stateDirectory = originalDirectory;
    config.aiApiKey = originalKey;
    config.aiModels = originalModels;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
