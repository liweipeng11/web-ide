import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createCapabilityRouter } from "./capabilityRoutes.js";
import { createServerCapabilities, defaultFeatureFlags, getStableRolloutBucket, readExplicitCompletionRollout, readFeatureFlags, recordFeatureDecisionDifference, resolveExplicitCompletionRollout, resolveFeaturePath, selectFeaturePath, type FeatureFlags } from "./featureFlags.js";
import { buildSafeEditRecommendation, evaluateSafeEditRollout } from "./safeEditor/index.js";

test("Feature Flag 默认启用并支持常用布尔值和显式回退", () => {
  assert.deepEqual(readFeatureFlags({}), defaultFeatureFlags);
  assert.deepEqual(readFeatureFlags({ CONTEXT_BUDGET_V2_ENABLED: "true", MODEL_PROVIDER_GATEWAY_ENABLED: "1", LSP_ENABLED: "yes", INLINE_EDIT_ENABLED: "on", COMMAND_EXECUTION_V2_ENABLED: "true", AGENT_PLANNED_FILE_RESOLUTION: "true", AGENT_SEMANTIC_COMPLETION_CHECK: "true", SAFE_EDIT_EVIDENCE_V2_ENABLED: "true", AGENT_EXPLICIT_COMPLETION_TOOL: "true" }), { contextBudgetV2: true, modelProviderGateway: true, lsp: true, inlineEdit: true, commandExecutionV2: true, plannedFileResolution: true, semanticCompletionCheck: true, safeEditEvidenceV2: true, explicitCompletionTool: true });
  assert.deepEqual(readFeatureFlags({ CONTEXT_BUDGET_V2_ENABLED: "false", MODEL_PROVIDER_GATEWAY_ENABLED: "0", LSP_ENABLED: "no", INLINE_EDIT_ENABLED: "off", COMMAND_EXECUTION_V2_ENABLED: "0", AGENT_PLANNED_FILE_RESOLUTION: "false", AGENT_SEMANTIC_COMPLETION_CHECK: "off", SAFE_EDIT_EVIDENCE_V2_ENABLED: "false", AGENT_EXPLICIT_COMPLETION_TOOL: "false" }), { contextBudgetV2: false, modelProviderGateway: false, lsp: false, inlineEdit: false, commandExecutionV2: false, plannedFileResolution: false, semanticCompletionCheck: false, safeEditEvidenceV2: false, explicitCompletionTool: false });
  assert.deepEqual(readFeatureFlags({ LSP_ENABLED: "invalid-value" }), defaultFeatureFlags);
});

test("Capability API 返回脱敏能力快照", async () => {
  const app = express();
  app.use("/api", createCapabilityRouter({ flags: { contextBudgetV2: true, modelProviderGateway: true, lsp: false, inlineEdit: false, commandExecutionV2: true, plannedFileResolution: true, semanticCompletionCheck: true, safeEditEvidenceV2: true, explicitCompletionTool: true }, implementations: { contextBudgetV2: false, modelProviderGateway: false, lsp: false, inlineEdit: false, commandExecutionV2: false, plannedFileResolution: false, semanticCompletionCheck: false, safeEditEvidenceV2: false, explicitCompletionTool: false }, aiConfigured: true, defaultModel: "mock-model" }));
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
  const names = ["contextBudgetV2", "modelProviderGateway", "lsp", "inlineEdit", "commandExecutionV2", "plannedFileResolution", "semanticCompletionCheck", "safeEditEvidenceV2", "explicitCompletionTool"] as const;
  const allAvailable = { contextBudgetV2: true, modelProviderGateway: true, lsp: true, inlineEdit: true, commandExecutionV2: true, plannedFileResolution: true, semanticCompletionCheck: true, safeEditEvidenceV2: true, explicitCompletionTool: true };
  for (const name of names) {
    const disabled = { contextBudgetV2: false, modelProviderGateway: false, lsp: false, inlineEdit: false, commandExecutionV2: false, plannedFileResolution: false, semanticCompletionCheck: false, safeEditEvidenceV2: false, explicitCompletionTool: false } satisfies FeatureFlags;
    assert.equal(resolveFeaturePath(name, disabled, allAvailable), "legacy");

    const enabled = { ...disabled, [name]: true };
    assert.equal(resolveFeaturePath(name, enabled, allAvailable), "next");
    const capabilities = createServerCapabilities({ flags: enabled, implementations: allAvailable, aiConfigured: true, defaultModel: "mock" });
    assert.deepEqual(capabilities.features[name], { enabled: true, available: true, active: true, path: "next" });
    assert.equal(names.filter((item) => item !== name).every((item) => capabilities.features[item].path === "legacy"), true);
  }
});

test("灰度差异仅记录脱敏后的新旧决策变化", () => {
  const logs: string[] = [];
  assert.equal(recordFeatureDecisionDifference({
    feature: "plannedFileResolution",
    legacyDecision: { unresolvedCount: 1 },
    nextDecision: { unresolvedCount: 0 }
  }, (message) => logs.push(message)), true);
  assert.equal(recordFeatureDecisionDifference({
    feature: "semanticCompletionCheck",
    legacyDecision: { status: "completed" },
    nextDecision: { status: "completed" }
  }, (message) => logs.push(message)), false);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /plannedFileResolution/);
  assert.doesNotMatch(logs[0], /source|prompt|content/i);
});

test("Safe Edit Evidence V2 默认启用且可通过环境变量立即回滚", () => {
  assert.equal(readFeatureFlags({}).safeEditEvidenceV2, true);
  assert.equal(readFeatureFlags({ SAFE_EDIT_EVIDENCE_V2_ENABLED: "0" }).safeEditEvidenceV2, false);
  assert.equal(readFeatureFlags({ SAFE_EDIT_EVIDENCE_V2_ENABLED: "1" }).safeEditEvidenceV2, true);
});

test("Safe Edit Evidence V2 灰度开关可在新旧判定间切换", () => {
  const input = {
    taskDescription: "接入 Vue Router",
    recommendation: buildSafeEditRecommendation({}),
    candidates: [
      { filePath: "src/main.js", status: "modify" as const, oldContent: "old", newContent: "new" },
      { filePath: "src/router/index.js", status: "create" as const, oldContent: "", newContent: "router" }
    ]
  };
  const enabled = evaluateSafeEditRollout(input, true);
  const rolledBack = evaluateSafeEditRollout(input, false);

  assert.equal(enabled.report.status, "needs_analysis");
  assert.equal(rolledBack.report.status, "high_risk");
  assert.equal(enabled.falseExpansionRegressionCount, 2);
});

test("显式完成工具默认启用并支持环境变量回滚", () => {
  assert.equal(readFeatureFlags({}).explicitCompletionTool, true);
  assert.equal(readFeatureFlags({ AGENT_EXPLICIT_COMPLETION_TOOL: "0" }).explicitCompletionTool, false);
  assert.equal(readFeatureFlags({ AGENT_EXPLICIT_COMPLETION_TOOL: "1" }).explicitCompletionTool, true);
});

test("显式完成协议支持影子、10%、50%、全量与严格灰度", () => {
  assert.deepEqual(readExplicitCompletionRollout({}), { mode: "shadow" });
  assert.deepEqual(readExplicitCompletionRollout({ AGENT_EXPLICIT_COMPLETION_ROLLOUT: "50" }), { mode: "50" });
  assert.deepEqual(readExplicitCompletionRollout({ AGENT_EXPLICIT_COMPLETION_ROLLOUT: "invalid" }), { mode: "shadow" });

  const common = { taskKey: "stable-task", featureEnabled: true, implementationAvailable: true, toolRegistered: true };
  assert.equal(resolveExplicitCompletionRollout({ ...common, config: { mode: "shadow" } }).enforceExplicitCompletion, false);
  assert.equal(resolveExplicitCompletionRollout({ ...common, config: { mode: "all" } }).enforceExplicitCompletion, true);
  assert.equal(resolveExplicitCompletionRollout({ ...common, config: { mode: "strict" } }).compareLegacyDecision, false);
  assert.equal(resolveExplicitCompletionRollout({ ...common, featureEnabled: false, config: { mode: "all" } }).toolAvailable, false);
  assert.equal(getStableRolloutBucket("stable-task"), getStableRolloutBucket("stable-task"));
});

test("百分比灰度使用稳定任务分桶且覆盖率符合配置", () => {
  const decisions = Array.from({ length: 1_000 }, (_, index) => {
    const common = { taskKey: `task-${index}`, featureEnabled: true, implementationAvailable: true, toolRegistered: true };
    return {
      ten: resolveExplicitCompletionRollout({ ...common, config: { mode: "10" } }).enforceExplicitCompletion,
      fifty: resolveExplicitCompletionRollout({ ...common, config: { mode: "50" } }).enforceExplicitCompletion
    };
  });
  const tenRate = decisions.filter((item) => item.ten).length / decisions.length;
  const fiftyRate = decisions.filter((item) => item.fifty).length / decisions.length;
  assert.ok(tenRate >= 0.08 && tenRate <= 0.12, `10% 灰度实际比例为 ${tenRate}`);
  assert.ok(fiftyRate >= 0.47 && fiftyRate <= 0.53, `50% 灰度实际比例为 ${fiftyRate}`);
});
