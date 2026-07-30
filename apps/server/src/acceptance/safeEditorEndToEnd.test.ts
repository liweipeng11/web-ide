import assert from "node:assert/strict";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { analyzeImpact } from "../impactAnalyzer/index.js";
import { validateAgentGeneratedPatchImports } from "../agentPatchTools.js";
import { applyPendingPatch } from "../patchApplyService.js";
import { clearPendingPatches, createPendingPatch } from "../patchStore.js";
import {
  createStructuredModificationPlan,
  evaluateSafeEdit,
  preparePatchSafeEditRecommendation,
  recoverPatchSafeEditReport
} from "../safeEditor/index.js";
import { createVue2RouterFixture } from "../testing/vue2RouterFixture.js";
import type { PatchFileChange } from "../types.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

const execAsync = promisify(exec);

function patchFile(path: string, status: PatchFileChange["status"], oldContent: string, newContent: string, summary: string): PatchFileChange {
  return { path, filePath: path, status, oldContent, newContent, summary, diffHtml: "" };
}

test("阶段六：Vue Router 双文件计划完成自动分析、虚拟文件图、应用和构建", async (context) => {
  const fixture = await createVue2RouterFixture();
  context.after(async () => {
    clearPendingPatches();
    await fixture.cleanup();
  });
  await setWorkspaceRoot(fixture.fixtureRoot, { persist: false });

  const prefix = fixture.projectPath.replace(/\\/g, "/");
  const mainPath = `${prefix}/src/main.js`;
  const routerPath = `${prefix}/src/router/index.js`;
  const unrelatedPath = `${prefix}/src/components/Unrelated.vue`;
  const oldMain = await fs.readFile(path.join(fixture.projectRoot, "src", "main.js"), "utf8");
  const newMain = oldMain
    .replace('import App from "./App.vue";', 'import App from "./App.vue";\nimport router from "./router";')
    .replace("new Vue({\n  render:", "new Vue({\n  router,\n  render:");
  const routerContent = [
    'import Vue from "vue";',
    'import VueRouter from "vue-router";',
    'import CreateUserId from "@/views/createuserid.vue";',
    "",
    "Vue.use(VueRouter);",
    "",
    "export default new VueRouter({",
    "  routes: [",
    '    { path: "/createUserId", component: CreateUserId },',
    '    { path: "/", redirect: "/createUserId" }',
    "  ]",
    "});",
    ""
  ].join("\n");
  const files = [
    patchFile(routerPath, "create", "", routerContent, "创建 Vue Router 配置"),
    patchFile(mainPath, "modify", oldMain, newMain, "在 Vue 入口注入 Router")
  ];
  const plan = createStructuredModificationPlan({
    taskDescription: "接入 createuserid Vue Router 路由",
    files: [
      { filePath: mainPath, changeKind: "modify", reason: "在 Vue 根实例注入 Router" },
      { filePath: routerPath, changeKind: "create", reason: "创建路由配置" }
    ]
  });

  const preflight = await preparePatchSafeEditRecommendation({
    workspaceRoot: fixture.fixtureRoot,
    selectedFilePath: mainPath,
    modificationPlan: plan,
    executeImpactAnalysis: analyzeImpact
  });
  assert.equal(preflight.analysisAttemptCount, 1);
  assert.deepEqual(preflight.recommendation.evidence.sources, ["agent_plan", "planned_file_graph", "impact_analysis"]);

  const recovered = await recoverPatchSafeEditReport({
    workspaceRoot: fixture.fixtureRoot,
    selectedFilePath: mainPath,
    taskDescription: plan.taskDescription,
    modificationPlan: plan,
    executeImpactAnalysis: analyzeImpact,
    current: preflight,
    candidates: files.map((file) => ({
      filePath: file.path,
      status: file.status,
      oldContent: file.oldContent,
      newContent: file.newContent,
      summary: file.summary
    })),
    evidenceV2Enabled: true
  });
  assert.equal(recovered.report.status, "clean");
  assert.deepEqual(recovered.report.expansionFiles, []);
  assert.equal(recovered.telemetry.autoAnalysisAttemptCount, 1);
  assert.equal(recovered.telemetry.autoAnalysisSuccessCount, 1);

  const importValidation = await validateAgentGeneratedPatchImports(fixture.fixtureRoot, files);
  const routerReference = importValidation.fileResults
    .find((item) => item.file.path === mainPath)
    ?.result.checks.find((check) => check.target.value === "./router");
  assert.equal(importValidation.unresolved.length, 0);
  assert.equal(routerReference?.resolution.status, "planned_create");

  const patch = createPendingPatch(files, undefined, ["pnpm run build"], {
    rawPatchCount: 2,
    normalizedFilePaths: [routerPath, mainPath],
    preDedupeCount: 2,
    postDedupeCount: 2,
    finalPatchCount: 2,
    filteredCount: 0,
    noEffectCount: 0,
    records: [],
    safeEditReport: recovered.report,
    safeEditTelemetry: recovered.telemetry,
    generatedAt: Date.now()
  });
  const applied = await applyPendingPatch({ patchId: patch.patchId });
  assert.deepEqual(applied.files.map((file) => file.path).sort(), [mainPath, routerPath].sort());
  await execAsync("pnpm run build", { cwd: fixture.projectRoot });
  assert.match(await fs.readFile(path.join(fixture.projectRoot, "src", "router", "index.js"), "utf8"), /redirect: "\/createUserId"/);

  // 使用同一份完整证据验证真实计划外文件仍被单独拦截。
  const expansion = evaluateSafeEdit({
    taskDescription: plan.taskDescription,
    recommendation: preflight.recommendation,
    candidates: [{ filePath: unrelatedPath, status: "create", oldContent: "", newContent: "<template><div /></template>\n" }]
  });
  assert.equal(expansion.status, "high_risk");
  assert.deepEqual(expansion.expansionFiles, [unrelatedPath]);
  assert.equal(expansion.risks.filter((risk) => risk.kind === "scope_expansion").length, 1);
});
