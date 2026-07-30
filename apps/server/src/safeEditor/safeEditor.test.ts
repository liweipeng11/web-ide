import test from "node:test";
import assert from "node:assert/strict";
import type { ImpactAnalysisResult } from "../impactAnalyzer/index.js";
import { buildSafeEditRecommendation, createStructuredModificationPlan, evaluateSafeEdit, resolveSafeEditEvidence } from "./index.js";

function createImpactAnalysis(changeKind: "modify" | "signature" = "modify"): ImpactAnalysisResult {
  return {
    changes: [{ filePath: "src/userService.ts", symbolName: "getUser", changeKind, status: "resolved", definitions: [] }],
    impactedFiles: [
      { filePath: "src/userController.ts", depth: 1, impact: "direct", categories: ["implementation"], reasons: [{ kind: "symbol_reference", sourceFile: "src/userController.ts", targetFile: "src/userService.ts", symbolName: "getUser" }], affectedSymbols: [] },
      { filePath: "src/userService.test.ts", depth: 1, impact: "direct", categories: ["test"], reasons: [{ kind: "symbol_reference", sourceFile: "src/userService.test.ts", targetFile: "src/userService.ts", symbolName: "getUser" }], affectedSymbols: [] }
    ],
    relatedTests: ["src/userService.test.ts"], boundaryFiles: [], risk: { level: "medium", score: 3, factors: [] }, diagnostics: [], complete: true, truncated: false,
    indexedFileCount: 3, indexedSymbolCount: 3, unresolvedReferenceCount: 0, indexedUnresolvedReferenceCount: 0
  };
}

test("普通修改只把目标文件纳入最小修改集合", () => {
  const recommendation = buildSafeEditRecommendation({ impactAnalysis: createImpactAnalysis("modify"), fallbackTargetFiles: ["src/currentlySelected.ts"] });
  assert.deepEqual(recommendation.requiredFiles, ["src/userService.ts"]);
  assert.deepEqual(recommendation.conditionalFiles, []);
  assert.deepEqual(recommendation.validationFiles, ["src/userController.ts", "src/userService.test.ts"]);
  assert.deepEqual(recommendation.evidence, { sources: ["impact_analysis"], complete: true, diagnostics: [] });
});

test("签名变更把直接消费者列为条件修改，但测试仍作为验证文件", () => {
  const recommendation = buildSafeEditRecommendation({ impactAnalysis: createImpactAnalysis("signature") });
  assert.deepEqual(recommendation.conditionalFiles, ["src/userController.ts"]);
  assert.deepEqual(recommendation.validationFiles, ["src/userService.test.ts"]);
});

test("影响目标无法解析时不使用界面选中文件掩盖分析缺口", () => {
  const impactAnalysis = createImpactAnalysis();
  impactAnalysis.changes[0].status = "missing";
  impactAnalysis.complete = false;
  impactAnalysis.diagnostics = ["未找到变更目标：src/userService.ts#getUser"];
  const recommendation = buildSafeEditRecommendation({ impactAnalysis, fallbackTargetFiles: ["src/currentlySelected.ts"] });

  assert.deepEqual(recommendation.requiredFiles, []);
  assert.equal(recommendation.impactAnalysisComplete, false);
  const report = evaluateSafeEdit({ taskDescription: "修改用户服务", recommendation, candidates: [{ filePath: "src/userService.ts", status: "modify", oldContent: "old", newContent: "new" }] });
  assert.equal(report.status, "needs_analysis");
  assert.equal(report.files[0].role, "unverified");
  assert.ok(report.risks.some((risk) => risk.kind === "incomplete_impact_analysis"));
});

test("不完整分析之外的候选文件保持未验证，不会被描述成确认扩散", () => {
  const impactAnalysis = createImpactAnalysis();
  impactAnalysis.complete = false;
  impactAnalysis.diagnostics = ["符号索引达到上限"];
  const report = evaluateSafeEdit({
    taskDescription: "修改用户服务",
    recommendation: buildSafeEditRecommendation({ impactAnalysis }),
    candidates: [{ filePath: "src/unknownConsumer.ts", status: "modify", oldContent: "old", newContent: "new" }]
  });

  assert.equal(report.status, "needs_analysis");
  assert.equal(report.files[0].role, "unverified");
  assert.deepEqual(report.expansionFiles, []);
  assert.ok(report.risks.some((risk) => risk.kind === "incomplete_impact_analysis"));
  assert.ok(!report.risks.some((risk) => risk.kind === "scope_expansion"));
});

test("标记最小集合之外的扩散改动", () => {
  const report = evaluateSafeEdit({
    taskDescription: "修复用户查询错误",
    recommendation: buildSafeEditRecommendation({ impactAnalysis: createImpactAnalysis() }),
    candidates: [{ filePath: "src/orderService.ts", status: "modify", oldContent: "export const value = 1;", newContent: "export const value = 2;", summary: "同步清理订单服务" }]
  });
  assert.equal(report.status, "high_risk");
  assert.deepEqual(report.expansionFiles, ["src/orderService.ts"]);
  assert.ok(report.risks.some((risk) => risk.kind === "scope_expansion"));
  assert.ok(report.risks.some((risk) => risk.kind === "opportunistic_refactor"));
});

test("识别用户未要求的纯格式化和重命名", () => {
  const report = evaluateSafeEdit({
    taskDescription: "修复返回值",
    recommendation: buildSafeEditRecommendation({ fallbackTargetFiles: ["src/userService.ts"] }),
    candidates: [{ filePath: "src/userService.ts", status: "modify", oldContent: "const value=1\n", newContent: "const value = 1\n", summary: "格式化并重命名局部变量" }]
  });
  assert.equal(report.status, "warning");
  assert.ok(report.risks.some((risk) => risk.kind === "formatting_only"));
  assert.ok(report.risks.some((risk) => risk.kind === "bulk_rename"));
});

test("没有明确目标和影响分析时不会把模型输出反向当成安全范围", () => {
  const report = evaluateSafeEdit({
    taskDescription: "修改用户功能",
    recommendation: buildSafeEditRecommendation({}),
    candidates: [{ filePath: "src/userService.ts", status: "modify", oldContent: "old", newContent: "new" }]
  });

  assert.equal(report.status, "needs_analysis");
  assert.equal(report.recommendation.evidenceSource, "none");
  assert.deepEqual(report.recommendation.evidence, { sources: [], complete: false, diagnostics: [] });
  assert.equal(report.files[0].role, "unverified");
  assert.deepEqual(report.expansionFiles, []);
  assert.ok(report.risks.some((risk) => risk.kind === "missing_impact_analysis"));
  assert.ok(!report.risks.some((risk) => risk.kind === "scope_expansion"));
});

test("即使摘要未声明，也能从 diff 识别批量标识符重命名", () => {
  const report = evaluateSafeEdit({
    taskDescription: "修复返回值",
    recommendation: buildSafeEditRecommendation({ fallbackTargetFiles: ["src/userService.ts"] }),
    candidates: [{
      filePath: "src/userService.ts",
      status: "modify",
      oldContent: "const oldName = 1;\nuse(oldName);\nreturn oldName;\n",
      newContent: "const newName = 1;\nuse(newName);\nreturn newName;\n"
    }]
  });

  assert.ok(report.risks.some((risk) => risk.kind === "bulk_rename"));
});

test("用户明确要求补测试时把影响链测试文件视为配套改动", () => {
  const report = evaluateSafeEdit({
    taskDescription: "修改用户服务并补充单元测试",
    recommendation: buildSafeEditRecommendation({ impactAnalysis: createImpactAnalysis() }),
    candidates: [{ filePath: "src/userService.test.ts", status: "modify", oldContent: "old", newContent: "new" }]
  });

  assert.equal(report.files[0].role, "supporting");
  assert.equal(report.status, "clean");
});

test("组合证据去重并保留未来计划证据来源", () => {
  const recommendation = buildSafeEditRecommendation({
    fallbackTargetFiles: ["src/userService.ts"],
    evidence: {
      sources: ["agent_plan", "planned_file_graph", "agent_plan"],
      complete: true,
      diagnostics: ["计划文件图已验证"]
    }
  });

  assert.deepEqual(recommendation.evidence, {
    sources: ["agent_plan", "planned_file_graph", "explicit_target"],
    complete: true,
    diagnostics: ["计划文件图已验证"]
  });
  assert.equal(recommendation.evidenceSource, "explicit_target");
});

test("影响分析与结构化计划组合时合并目标且保留两类证据", () => {
  const modificationPlan = createStructuredModificationPlan({
    taskDescription: "修改服务并同步控制器",
    files: [{ filePath: "src/userController.ts", changeKind: "modify", responsibility: "适配调用", reason: "同步服务接口变化" }]
  });
  const recommendation = buildSafeEditRecommendation({ impactAnalysis: createImpactAnalysis(), modificationPlan });

  assert.deepEqual(recommendation.requiredFiles, ["src/userService.ts", "src/userController.ts"]);
  assert.deepEqual(recommendation.evidence.sources, ["impact_analysis", "agent_plan"]);
});

test("预检明确失败时修改计划不能把证据覆盖成完整", () => {
  const modificationPlan = createStructuredModificationPlan({
    taskDescription: "修改入口和路由",
    files: [{ filePath: "src/main.ts", changeKind: "modify", reason: "更新入口" }]
  });
  const recommendation = buildSafeEditRecommendation({
    modificationPlan,
    evidence: { sources: ["agent_plan"], complete: false, diagnostics: ["自动分析失败"] }
  });
  const report = evaluateSafeEdit({
    taskDescription: modificationPlan.taskDescription,
    recommendation,
    candidates: [{ filePath: "src/main.ts", status: "modify", oldContent: "old", newContent: "new" }]
  });

  assert.equal(recommendation.evidence.complete, false);
  assert.equal(report.status, "needs_analysis");
  assert.equal(report.risks.some((risk) => risk.kind === "incomplete_impact_analysis"), true);
});

test("历史报告缺少组合证据字段时仍可反序列化并推导证据", () => {
  const legacyJson = JSON.stringify({
    status: "clean",
    recommendation: {
      requiredFiles: ["src/userService.ts"],
      conditionalFiles: [],
      validationFiles: [],
      editableScopeFiles: [],
      impactAnalysisComplete: true,
      evidenceSource: "impact_analysis",
      diagnostics: []
    },
    files: [],
    necessaryFiles: ["src/userService.ts"],
    expansionFiles: [],
    risks: []
  });
  const legacyReport = JSON.parse(legacyJson) as { recommendation: Parameters<typeof resolveSafeEditEvidence>[0] };

  assert.doesNotThrow(() => resolveSafeEditEvidence(legacyReport.recommendation));
  assert.deepEqual(resolveSafeEditEvidence(legacyReport.recommendation), {
    sources: ["impact_analysis"],
    complete: true,
    diagnostics: []
  });
});
