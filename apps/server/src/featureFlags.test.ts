import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createCapabilityRouter } from "./capabilityRoutes.js";
import { createServerCapabilities, defaultFeatureFlags, getStableRolloutBucket, readCompletionPolicyRollout, readExplicitCompletionRollout, readFeatureFlags, readProgressiveDeliveryRollout, recordFeatureDecisionDifference, resolveCompletionPolicyRollout, resolveExplicitCompletionRollout, resolveFeaturePath, resolveProgressiveDeliveryRollout, selectFeaturePath, type FeatureFlags } from "./featureFlags.js";
import { buildSafeEditRecommendation, evaluateSafeEditRollout } from "./safeEditor/index.js";

test("渐进交付开关默认关闭，且可通过环境变量显式启用或回退", () => {
  assert.equal(readFeatureFlags({}).progressiveDelivery, false);
  assert.equal(readFeatureFlags({ AGENT_PROGRESSIVE_DELIVERY_ENABLED: "1" }).progressiveDelivery, true);
  assert.equal(readFeatureFlags({ AGENT_PROGRESSIVE_DELIVERY_ENABLED: "invalid" }).progressiveDelivery, false);
});

test("渐进恢复开关默认关闭，且可独立灰度启用", () => {
  assert.equal(readFeatureFlags({}).progressiveRecovery, false);
  assert.equal(readFeatureFlags({ AGENT_PROGRESSIVE_RECOVERY_ENABLED: "1" }).progressiveRecovery, true);
  assert.equal(readFeatureFlags({ AGENT_PROGRESSIVE_RECOVERY_ENABLED: "invalid" }).progressiveRecovery, false);
});

test("阶段六渐进交付灰度支持影子、内部、小比例和全量，并可由 Flag 立即回退", () => {
  assert.deepEqual(readProgressiveDeliveryRollout({}), { mode: "all" });
  assert.deepEqual(readProgressiveDeliveryRollout({ AGENT_PROGRESSIVE_DELIVERY_ROLLOUT: "invalid" }), { mode: "shadow" });
  const flags = { progressiveDelivery: true, progressiveRecovery: true, unitContextBudget: true };
  assert.deepEqual(resolveProgressiveDeliveryRollout({ taskKey: "task-a", flags, config: { mode: "shadow" } }), {
    progressiveDelivery: false, progressiveRecovery: false, unitContextBudget: false
  });
  assert.equal(resolveProgressiveDeliveryRollout({ taskKey: "internal", flags, config: { mode: "internal" }, internalTask: true }).progressiveRecovery, true);
  assert.equal(resolveProgressiveDeliveryRollout({ taskKey: "external", flags, config: { mode: "internal" }, internalTask: false }).progressiveRecovery, false);
  const ten = Array.from({ length: 1_000 }, (_, index) => resolveProgressiveDeliveryRollout({ taskKey: `progressive-${index}`, flags, config: { mode: "10" } }).progressiveRecovery).filter(Boolean).length;
  assert.ok(ten >= 80 && ten <= 120);
  assert.equal(resolveProgressiveDeliveryRollout({ taskKey: "rollback", flags: { ...flags, progressiveRecovery: false }, config: { mode: "all" } }).progressiveRecovery, false);
});

test("Feature Flag 默认启用并支持常用布尔值和显式回退", () => {
  assert.deepEqual(readFeatureFlags({}), defaultFeatureFlags);
  assert.deepEqual(readFeatureFlags({ CONTEXT_BUDGET_V2_ENABLED: "true", MODEL_PROVIDER_GATEWAY_ENABLED: "1", LSP_ENABLED: "yes", INLINE_EDIT_ENABLED: "on", COMMAND_EXECUTION_V2_ENABLED: "true", AGENT_PLANNED_FILE_RESOLUTION: "true", AGENT_SEMANTIC_COMPLETION_CHECK: "true", SAFE_EDIT_EVIDENCE_V2_ENABLED: "true", AGENT_EXPLICIT_COMPLETION_TOOL: "true", AGENT_TASK_RUNTIME_EVIDENCE_PERSISTENCE: "true", AGENT_COMPLETION_REJECTION_CONVERGENCE: "true", AGENT_STRUCTURED_COMPLETION_REJECTION: "true" }), defaultFeatureFlags);
  assert.deepEqual(readFeatureFlags({ CONTEXT_BUDGET_V2_ENABLED: "false", MODEL_PROVIDER_GATEWAY_ENABLED: "0", LSP_ENABLED: "no", INLINE_EDIT_ENABLED: "off", COMMAND_EXECUTION_V2_ENABLED: "0", AGENT_PLANNED_FILE_RESOLUTION: "false", AGENT_SEMANTIC_COMPLETION_CHECK: "off", SAFE_EDIT_EVIDENCE_V2_ENABLED: "false", AGENT_EXPLICIT_COMPLETION_TOOL: "false", AGENT_TASK_RUNTIME_EVIDENCE_PERSISTENCE: "false", AGENT_COMPLETION_REJECTION_CONVERGENCE: "false", AGENT_STRUCTURED_COMPLETION_REJECTION: "false" }), Object.fromEntries(Object.keys(defaultFeatureFlags).map((key) => [key, false])));
  assert.deepEqual(readFeatureFlags({ LSP_ENABLED: "invalid-value" }), defaultFeatureFlags);
});

test("Capability API 返回脱敏能力快照", async () => {
  const app = express();
  app.use("/api", createCapabilityRouter({ flags: { ...defaultFeatureFlags, lsp: false, inlineEdit: false }, implementations: Object.fromEntries(Object.keys(defaultFeatureFlags).map((key) => [key, false])) as typeof defaultFeatureFlags, aiConfigured: true, defaultModel: "mock-model" }));
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
  const names = Object.keys(defaultFeatureFlags) as Array<keyof FeatureFlags>;
  // 开关默认值与实现可用性相互独立；阶段 0 的新开关默认关闭但仍应可验证通用途径选择。
  const allAvailable = Object.fromEntries(names.map((name) => [name, true])) as FeatureFlags;
  for (const name of names) {
    const disabled = Object.fromEntries(names.map((item) => [item, false])) as FeatureFlags;
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

test("任务完成策略支持独立回滚与稳定的 10%、50%、全量灰度", () => {
  assert.deepEqual(readCompletionPolicyRollout({}), { mode: "all" });
  assert.deepEqual(readCompletionPolicyRollout({ AGENT_TASK_COMPLETION_ROLLOUT: "invalid" }), { mode: "off" });
  const flags = {
    taskRuntimeEvidencePersistence: true,
    completionRejectionConvergence: true,
    structuredCompletionRejection: true
  };
  assert.deepEqual(resolveCompletionPolicyRollout({ taskKey: "task-a", flags, config: { mode: "off" } }), {
    taskRuntimeEvidencePersistence: false,
    completionRejectionConvergence: false,
    structuredCompletionRejection: false
  });
  assert.deepEqual(resolveCompletionPolicyRollout({ taskKey: "task-a", flags: { ...flags, structuredCompletionRejection: false }, config: { mode: "all" } }), {
    taskRuntimeEvidencePersistence: true,
    completionRejectionConvergence: true,
    structuredCompletionRejection: false
  });

  const decisions = Array.from({ length: 1_000 }, (_, index) => ({
    ten: resolveCompletionPolicyRollout({ taskKey: `completion-${index}`, flags, config: { mode: "10" } }).completionRejectionConvergence,
    fifty: resolveCompletionPolicyRollout({ taskKey: `completion-${index}`, flags, config: { mode: "50" } }).completionRejectionConvergence
  }));
  assert.ok(decisions.filter((item) => item.ten).length >= 80 && decisions.filter((item) => item.ten).length <= 120);
  assert.ok(decisions.filter((item) => item.fifty).length >= 470 && decisions.filter((item) => item.fifty).length <= 530);
});
