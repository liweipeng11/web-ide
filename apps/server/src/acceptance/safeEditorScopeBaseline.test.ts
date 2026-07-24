import assert from "node:assert/strict";
import test from "node:test";
import { buildSafeEditRecommendation, evaluateSafeEdit } from "../safeEditor/index.js";
import type { SafeEditCandidate } from "../safeEditor/types.js";

const mainFile = "clr-vue-app/src/main.js";
const routerFile = "clr-vue-app/src/router/index.js";
const unrelatedFile = "clr-vue-app/src/components/Unrelated.vue";

function createVueRouterCandidates(): SafeEditCandidate[] {
  return [
    {
      filePath: routerFile,
      status: "create",
      oldContent: "",
      newContent: "export default new VueRouter({ routes: [] });\n",
      summary: "创建 Vue Router 配置"
    },
    {
      filePath: mainFile,
      status: "modify",
      oldContent: "new Vue({ render: h => h(App) }).$mount(\"#app\");\n",
      newContent: "new Vue({ router, render: h => h(App) }).$mount(\"#app\");\n",
      summary: "将 router 注入 Vue 根实例"
    }
  ];
}

test("回归：缺少影响分析时 Vue Router 双文件保持未验证且等待分析", () => {
  // 不提供显式目标或影响分析，验证阶段 1 不再把证据缺口描述成确认扩散。
  const report = evaluateSafeEdit({
    taskDescription: "将 createuserid.vue 页面添加到路由中，并在根路径重定向",
    recommendation: buildSafeEditRecommendation({}),
    candidates: createVueRouterCandidates()
  });

  assert.equal(report.recommendation.evidenceSource, "none");
  assert.equal(report.status, "needs_analysis");
  assert.deepEqual(report.necessaryFiles, []);
  assert.deepEqual(report.expansionFiles, []);

  for (const file of report.files) {
    assert.equal(file.role, "unverified");
    assert.deepEqual(file.risks.map((risk) => risk.kind), ["missing_impact_analysis"]);
    assert.ok(file.risks.every((risk) => risk.level === "high"));
  }
});

test("对照：存在明确双文件范围时，仅额外修改的无关组件被识别为真实扩散", () => {
  const report = evaluateSafeEdit({
    taskDescription: "将 createuserid.vue 页面添加到路由中，并在根路径重定向",
    recommendation: buildSafeEditRecommendation({
      fallbackTargetFiles: [routerFile, mainFile]
    }),
    candidates: [
      ...createVueRouterCandidates(),
      {
        filePath: unrelatedFile,
        status: "modify",
        oldContent: "<template><div>原内容</div></template>\n",
        newContent: "<template><div>无关改动</div></template>\n",
        summary: "额外修改无关组件"
      }
    ]
  });

  assert.equal(report.recommendation.evidenceSource, "explicit_target");
  assert.equal(report.status, "high_risk");
  assert.deepEqual(report.necessaryFiles, [routerFile, mainFile]);
  assert.deepEqual(report.expansionFiles, [unrelatedFile]);
  assert.deepEqual(
    report.files.map((file) => [file.filePath, file.role]),
    [
      [routerFile, "required"],
      [mainFile, "required"],
      [unrelatedFile, "expansion"]
    ]
  );
  assert.deepEqual(
    report.risks.map((risk) => [risk.filePath, risk.kind]),
    [[unrelatedFile, "scope_expansion"]]
  );
});
