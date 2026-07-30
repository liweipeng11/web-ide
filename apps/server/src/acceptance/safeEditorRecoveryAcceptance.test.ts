import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeImpact } from "../impactAnalyzer/index.js";
import { createStructuredModificationPlan, preparePatchSafeEditRecommendation, recoverPatchSafeEditReport } from "../safeEditor/index.js";

async function createVueRouterWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-safe-editor-recovery-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "components"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "main.js"), "export function bootstrap() { return true }\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "components", "Unrelated.vue"), "<template><div /></template>\n", "utf8");
  return workspaceRoot;
}

test("阶段 4：Vue Router 双文件计划自动补齐证据且真实扩散仍被拦截", async (context) => {
  const workspaceRoot = await createVueRouterWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const modificationPlan = createStructuredModificationPlan({
    taskDescription: "为 Vue 应用接入 Router",
    files: [
      { filePath: "src/main.js", changeKind: "modify", reason: "在应用入口注入 router" },
      { filePath: "src/router/index.js", changeKind: "create", reason: "创建路由配置" }
    ]
  });
  let analysisCalls = 0;
  const executeImpactAnalysis = async (root: string, targets: Parameters<typeof analyzeImpact>[1], options?: Parameters<typeof analyzeImpact>[2]) => {
    analysisCalls += 1;
    return analyzeImpact(root, targets, options);
  };
  const state = await preparePatchSafeEditRecommendation({
    workspaceRoot,
    selectedFilePath: null,
    modificationPlan,
    executeImpactAnalysis
  });
  const expected = await recoverPatchSafeEditReport({
    workspaceRoot,
    selectedFilePath: null,
    taskDescription: modificationPlan.taskDescription,
    modificationPlan,
    candidates: [
      { filePath: "src/main.js", status: "modify", oldContent: "export function bootstrap() { return true }\n", newContent: "export function bootstrap(router) { return router }\n" },
      { filePath: "src/router/index.js", status: "create", oldContent: "", newContent: "export default []\n" }
    ],
    current: state,
    executeImpactAnalysis
  });

  assert.equal(analysisCalls, 1);
  assert.equal(expected.report.status, "clean");
  assert.deepEqual(expected.report.necessaryFiles, ["src/main.js", "src/router/index.js"]);
  assert.deepEqual(expected.report.recommendation.evidence.sources, ["agent_plan", "planned_file_graph", "impact_analysis"]);

  const expansion = await recoverPatchSafeEditReport({
    workspaceRoot,
    selectedFilePath: null,
    taskDescription: modificationPlan.taskDescription,
    modificationPlan,
    candidates: [{ filePath: "src/components/Unrelated.vue", status: "modify", oldContent: "old", newContent: "new" }],
    current: state,
    executeImpactAnalysis
  });
  assert.equal(analysisCalls, 1);
  assert.equal(expansion.report.status, "high_risk");
  assert.deepEqual(expansion.report.expansionFiles, ["src/components/Unrelated.vue"]);
  assert.equal(expansion.report.risks.some((risk) => risk.kind === "scope_expansion"), true);
});
