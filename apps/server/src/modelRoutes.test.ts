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

test("Provider 设置 API 持久化配置且不会返回完整 API Key", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "provider-settings-routes-"));
  const original = {
    stateDirectory: config.stateDirectory,
    aiApiKey: config.aiApiKey,
    aiBaseUrl: config.aiBaseUrl,
    aiModel: config.aiModel,
    aiModels: config.aiModels
  };
  config.stateDirectory = directory;
  config.aiApiKey = "";
  config.aiBaseUrl = "https://api.openai.com/v1";
  config.aiModel = "old-model";
  config.aiModels = ["old-model"];
  const app = express();
  app.use(express.json());
  app.use("/api", createModelRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    const apiKey = "provider-secret-value";
    const updateResponse = await fetch(`${baseUrl}/models/provider-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: "http://127.0.0.1:11434/v1/",
        apiKey,
        models: ["local-model", "local-model", "backup-model"]
      })
    });
    const updateText = await updateResponse.text();
    assert.equal(updateResponse.status, 200);
    assert.equal(updateText.includes(apiKey), false);
    const update = JSON.parse(updateText) as { settings: { baseUrl: string; models: string[]; credentialConfigured: boolean }; defaults: { chat: { modelId: string } } };
    assert.equal(update.settings.baseUrl, "http://127.0.0.1:11434/v1");
    assert.deepEqual(update.settings.models, ["local-model", "backup-model"]);
    assert.equal(update.settings.credentialConfigured, true);
    assert.equal(update.defaults.chat.modelId, "local-model");

    const stored = await fs.readFile(path.join(directory, "provider-settings.json"), "utf8");
    assert.equal(JSON.parse(stored).providers[0].apiKey, apiKey);
    const catalogText = await (await fetch(`${baseUrl}/models`)).text();
    assert.equal(catalogText.includes(apiKey), false);
    assert.match(catalogText, /local-model/);
    const createResponse = await fetch(`${baseUrl}/models/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "第二提供商", type: "openai-compatible" })
    });
    const created = await createResponse.json() as { settings: { providerId: string; name: string }; providerSettings: unknown[] };
    assert.equal(createResponse.status, 200);
    assert.equal(created.settings.name, "第二提供商");
    assert.equal(created.providerSettings.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    config.stateDirectory = original.stateDirectory;
    config.aiApiKey = original.aiApiKey;
    config.aiBaseUrl = original.aiBaseUrl;
    config.aiModel = original.aiModel;
    config.aiModels = original.aiModels;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Provider 检测 API 使用临时配置且响应不泄露凭据", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "provider-test-routes-"));
  const originalDirectory = config.stateDirectory;
  const originalKey = config.aiApiKey;
  config.stateDirectory = directory;
  config.aiApiKey = "";
  const providerApp = express();
  providerApp.get("/v1/models", (request, response) => {
    assert.equal(request.headers.authorization, "Bearer connection-secret");
    response.json({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }, { name: "invalid-model" }] });
  });
  const providerServer = http.createServer(providerApp);
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const providerAddress = providerServer.address();
  assert.ok(providerAddress && typeof providerAddress !== "string");

  const app = express();
  app.use(express.json());
  app.use("/api", createModelRouter());
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/models/provider-settings/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
        apiKey: "connection-secret"
      })
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes("connection-secret"), false);
    assert.deepEqual(JSON.parse(text), { available: true, message: "连接成功，发现 2 个可用模型", discoveredModelCount: 4, models: ["model-a", "model-b"] });
    await assert.rejects(fs.access(path.join(directory, "provider-settings.json")));
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
      new Promise<void>((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()))
    ]);
    config.stateDirectory = originalDirectory;
    config.aiApiKey = originalKey;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
