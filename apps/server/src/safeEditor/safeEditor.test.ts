import test from "node:test";
import assert from "node:assert/strict";
import type { ImpactAnalysisResult } from "../impactAnalyzer/index.js";
import { buildSafeEditRecommendation, evaluateSafeEdit } from "./index.js";

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
  assert.equal(report.status, "high_risk");
  assert.ok(report.risks.some((risk) => risk.kind === "incomplete_impact_analysis"));
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

  assert.equal(report.status, "high_risk");
  assert.equal(report.recommendation.evidenceSource, "none");
  assert.ok(report.risks.some((risk) => risk.kind === "missing_impact_analysis"));
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
