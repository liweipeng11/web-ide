import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSafeEditViewModel } from "../../../web/src/components/safeEditViewModel.js";
import type { SafeEditReport } from "../safeEditor/index.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const webSourceRoot = path.resolve(testDirectory, "../../../web/src");

function createReport(overrides: Partial<SafeEditReport>): SafeEditReport {
  return {
    status: "clean",
    recommendation: {
      requiredFiles: ["src/main.ts"],
      conditionalFiles: [],
      validationFiles: [],
      editableScopeFiles: ["src/main.ts"],
      impactAnalysisComplete: true,
      evidenceSource: "impact_analysis",
      evidence: { sources: ["agent_plan", "impact_analysis"], complete: true, diagnostics: ["引用关系已检查"] },
      diagnostics: []
    },
    files: [],
    necessaryFiles: ["src/main.ts"],
    expansionFiles: [],
    risks: [],
    ...overrides
  };
}

test("阶段 5：待分析状态使用独立文案并禁止直接应用", () => {
  const risk = {
    kind: "missing_impact_analysis" as const,
    level: "medium" as const,
    filePath: "src/main.ts",
    message: "缺少影响分析"
  };
  const model = createSafeEditViewModel(createReport({
    status: "needs_analysis",
    recommendation: {
      ...createReport({}).recommendation,
      impactAnalysisComplete: null,
      evidenceSource: "none",
      evidence: { sources: ["agent_plan"], complete: false, diagnostics: ["需要补充影响分析"] }
    },
    files: [{ filePath: "src/main.ts", role: "unverified", reasons: ["范围尚未验证"], addedLines: 1, removedLines: 0, risks: [risk] }],
    risks: [risk]
  }));

  assert.equal(model.status, "needs_analysis");
  assert.equal(model.title, "缺少修改范围证据");
  assert.equal(model.canApply, false);
  assert.equal(model.requiresApproval, false);
  assert.equal(model.files[0].risks.length, 1, "文件风险应在文件级合并去重");
});

test("阶段 5：真实扩散进入结构化审批且保留文件证据", () => {
  const risk = {
    kind: "scope_expansion" as const,
    level: "high" as const,
    filePath: "src/Unrelated.ts",
    message: "文件不在结构化修改计划内"
  };
  const model = createSafeEditViewModel(createReport({
    status: "high_risk",
    files: [{ filePath: risk.filePath, role: "expansion", reasons: ["计划外文件"], addedLines: 2, removedLines: 1, risks: [risk] }],
    expansionFiles: [risk.filePath],
    risks: [risk]
  }));

  assert.equal(model.status, "high_risk");
  assert.equal(model.title, "检测到确认的范围扩散");
  assert.equal(model.canApply, true);
  assert.equal(model.requiresApproval, true);
  assert.deepEqual(model.expansionFiles, [risk.filePath]);
  assert.deepEqual(model.evidenceLabels, ["结构化修改计划", "影响分析"]);
});

test("阶段 5：拒绝计划外文件不会误包含仅验证文件", () => {
  const model = createSafeEditViewModel(createReport({
    files: [
      { filePath: "src/Unrelated.ts", role: "expansion", reasons: [], addedLines: 1, removedLines: 0, risks: [] },
      { filePath: "src/main.test.ts", role: "validation_only", reasons: [], addedLines: 0, removedLines: 0, risks: [] }
    ],
    expansionFiles: ["src/Unrelated.ts", "src/main.test.ts"]
  }));

  assert.deepEqual(model.expansionFiles, ["src/Unrelated.ts"]);
});

test("阶段 5：前端审核链路不再使用原生高风险确认", async () => {
  const [actionsSource, paneSource, dialogSource] = await Promise.all([
    fs.readFile(path.join(webSourceRoot, "hooks/usePatchActions.ts"), "utf8"),
    fs.readFile(path.join(webSourceRoot, "components/PatchReviewPane.tsx"), "utf8"),
    fs.readFile(path.join(webSourceRoot, "components/SafeEditApprovalDialog.tsx"), "utf8")
  ]);

  assert.doesNotMatch(actionsSource, /Safe Editor[^\n]+window\.confirm|window\.confirm[^\n]+Safe Editor/);
  assert.match(paneSource, /补充影响分析/);
  assert.match(paneSource, /拒绝计划外文件/);
  assert.match(paneSource, /查看影响分析摘要/);
  assert.match(dialogSource, /确认风险并应用/);
  assert.match(dialogSource, /model\.status !== "high_risk"/);
});
