import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createCapabilityRouter } from "./capabilityRoutes.js";
import { createServerCapabilities, defaultFeatureFlags, readFeatureFlags, resolveFeaturePath, selectFeaturePath, type FeatureFlags } from "./featureFlags.js";

test("Feature Flag 默认启用并支持常用布尔值和显式回退", () => {
  assert.deepEqual(readFeatureFlags({}), defaultFeatureFlags);
  assert.deepEqual(readFeatureFlags({ CONTEXT_BUDGET_V2_ENABLED: "true", MODEL_PROVIDER_GATEWAY_ENABLED: "1", LSP_ENABLED: "yes", INLINE_EDIT_ENABLED: "on", COMMAND_EXECUTION_V2_ENABLED: "true" }), { contextBudgetV2: true, modelProviderGateway: true, lsp: true, inlineEdit: true, commandExecutionV2: true });
  assert.deepEqual(readFeatureFlags({ CONTEXT_BUDGET_V2_ENABLED: "false", MODEL_PROVIDER_GATEWAY_ENABLED: "0", LSP_ENABLED: "no", INLINE_EDIT_ENABLED: "off", COMMAND_EXECUTION_V2_ENABLED: "0" }), { contextBudgetV2: false, modelProviderGateway: false, lsp: false, inlineEdit: false, commandExecutionV2: false });
  assert.deepEqual(readFeatureFlags({ LSP_ENABLED: "invalid-value" }), defaultFeatureFlags);
});

test("Capability API 返回脱敏能力快照", async () => {
  const app = express();
  app.use("/api", createCapabilityRouter({ flags: { contextBudgetV2: true, modelProviderGateway: true, lsp: false, inlineEdit: false, commandExecutionV2: true }, implementations: { contextBudgetV2: false, modelProviderGateway: false, lsp: false, inlineEdit: false, commandExecutionV2: false }, aiConfigured: true, defaultModel: "mock-model" }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/capabilities`);
    const data = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(JSON.stringify(data).includes("apiKey"), false);
    assert.equal(JSON.stringify(data).includes("Authorization"), false);
    assert.equal((data.models as { configured: boolean }).configured, true);
    assert.equal((data.models as { selection: boolean }).selection, false);
    assert.deepEqual((data.features as Record<string, unknown>).modelProviderGateway, { enabled: true, available: false, active: false, path: "legacy" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Feature Flag 仅在实现可用时切换新路径，否则保持旧路径", () => {
  assert.equal(selectFeaturePath(false, true, () => "new", () => "legacy"), "legacy");
  assert.equal(selectFeaturePath(true, false, () => "new", () => "legacy"), "legacy");
  assert.equal(selectFeaturePath(true, true, () => "new", () => "legacy"), "new");
});

test("各项 Feature Flag 分别裁决 legacy 和 next 路径", () => {
  const names = ["contextBudgetV2", "modelProviderGateway", "lsp", "inlineEdit", "commandExecutionV2"] as const;
  const allAvailable = { contextBudgetV2: true, modelProviderGateway: true, lsp: true, inlineEdit: true, commandExecutionV2: true };
  for (const name of names) {
    const disabled = { contextBudgetV2: false, modelProviderGateway: false, lsp: false, inlineEdit: false, commandExecutionV2: false } satisfies FeatureFlags;
    assert.equal(resolveFeaturePath(name, disabled, allAvailable), "legacy");

    const enabled = { ...disabled, [name]: true };
    assert.equal(resolveFeaturePath(name, enabled, allAvailable), "next");
    const capabilities = createServerCapabilities({ flags: enabled, implementations: allAvailable, aiConfigured: true, defaultModel: "mock" });
    assert.deepEqual(capabilities.features[name], { enabled: true, available: true, active: true, path: "next" });
    assert.equal(names.filter((item) => item !== name).every((item) => capabilities.features[item].path === "legacy"), true);
  }
});
