import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeImpact, type ImpactAnalysisResult } from "../impactAnalyzer/index.js";
import { buildSafeEditRecommendation, createStructuredModificationPlan, decideImpactPreflight, executeImpactPreflight } from "./index.js";

function plan(files: Parameters<typeof createStructuredModificationPlan>[0]["files"]) {
  return createStructuredModificationPlan({ taskDescription: "动态影响分析预检", files, createdAt: 1 });
}

async function createWorkspace(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-preflight-"));
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return root;
}

test("单个局部实现与纯 create 计划跳过影响分析", () => {
  const local = decideImpactPreflight(plan([
    { filePath: "src/components/LocalPanel.tsx", changeKind: "modify", reason: "调整组件内部布局" }
  ]));
  const createOnly = decideImpactPreflight(plan([
    { filePath: "src/internal/newHelper.ts", changeKind: "create", reason: "新增内部辅助实现" }
  ]));

  assert.deepEqual({ strategy: local.strategy, reasons: local.reasons }, { strategy: "skip", reasons: ["local_single_file"] });
  assert.deepEqual({ strategy: createOnly.strategy, targets: createOnly.targets }, { strategy: "skip", targets: [] });
});

test("破坏性、多现有文件、公共符号、边界文件与跨包计划要求分析", () => {
  const destructive = decideImpactPreflight(plan([{ filePath: "src/service.ts", changeKind: "delete", reason: "删除废弃服务" }]));
  const multiple = decideImpactPreflight(plan([
    { filePath: "src/a.ts", changeKind: "modify", reason: "同步实现" },
    { filePath: "src/b.ts", changeKind: "modify", reason: "同步实现" }
  ]));
  const shared = decideImpactPreflight(plan([{ filePath: "src/service.ts", symbolName: "loadUser", changeKind: "modify", reason: "修改公共导出" }]));
  const boundary = decideImpactPreflight(plan([{ filePath: "src/main.ts", changeKind: "modify", reason: "注册插件" }]));
  const sharedConfig = decideImpactPreflight(plan([{ filePath: "vite.config.ts", changeKind: "modify", reason: "更新构建配置" }]));
  const crossPackage = decideImpactPreflight(plan([
    { filePath: "apps/web/src/api.ts", changeKind: "modify", reason: "同步类型" },
    { filePath: "packages/contracts/src/api.ts", changeKind: "modify", reason: "修改契约" }
  ]));

  assert.equal(destructive.reasons.includes("destructive_change"), true);
  assert.equal(multiple.reasons.includes("multiple_existing_files"), true);
  assert.equal(shared.reasons.includes("shared_symbol"), true);
  assert.equal(boundary.reasons.includes("boundary_file"), true);
  assert.equal(sharedConfig.reasons.includes("boundary_file"), true);
  assert.equal(crossPackage.reasons.includes("cross_package"), true);
  assert.equal([destructive, multiple, shared, boundary, sharedConfig, crossPackage].every((item) => item.strategy === "analyze"), true);
});

test("新建目标不进入分析，现有目标分析后与计划图证据合并", async () => {
  const root = await createWorkspace({
    "src/main.js": "export function boot() { return true }\n",
    "src/consumer.js": "import { boot } from './main.js'\nboot()\n"
  });
  const modificationPlan = plan([
    { filePath: "src/main.js", symbolName: "boot", changeKind: "modify", reason: "修改公共入口导出" },
    { filePath: "src/router/index.js", changeKind: "create", reason: "新增路由配置" }
  ]);
  let receivedTargets = 0;
  const preflight = await executeImpactPreflight({
    workspaceRoot: root,
    plan: modificationPlan,
    executeAnalysis: async (workspaceRoot, targets, options) => {
      receivedTargets = targets.length;
      return analyzeImpact(workspaceRoot, targets, options);
    }
  });
  const recommendation = buildSafeEditRecommendation({
    modificationPlan,
    impactAnalysis: preflight.analysis,
    evidence: preflight.evidence
  });

  assert.equal(receivedTargets, 1);
  assert.equal(preflight.decision.targets.some((target) => target.filePath === "src/router/index.js"), false);
  assert.deepEqual(preflight.evidence.sources, ["agent_plan", "planned_file_graph", "impact_analysis"]);
  assert.deepEqual(recommendation.requiredFiles, ["src/main.js", "src/router/index.js"]);
  assert.deepEqual(recommendation.evidence.sources, ["agent_plan", "planned_file_graph", "impact_analysis"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("仅复用完整、目标一致且未过期的分析", () => {
  const modificationPlan = plan([{ filePath: "src/main.ts", changeKind: "modify", reason: "更新入口" }]);
  const base = {
    analyzedAt: 10_000,
    changes: [{ filePath: "src/main.ts", changeKind: "modify", status: "resolved", definitions: [] }],
    impactedFiles: [], relatedTests: [], boundaryFiles: [], risk: { level: "low", score: 0, factors: [] },
    diagnostics: [], complete: true, truncated: false, indexedFileCount: 1, indexedSymbolCount: 0,
    unresolvedReferenceCount: 0, indexedUnresolvedReferenceCount: 0
  } satisfies ImpactAnalysisResult;

  assert.equal(decideImpactPreflight(modificationPlan, [base], { now: 10_001 }).strategy, "reuse");
  assert.equal(decideImpactPreflight(modificationPlan, [{ ...base, analyzedAt: 1 }], { now: 1_000_000 }).strategy, "analyze");
  assert.equal(decideImpactPreflight(modificationPlan, [{ ...base, complete: false }], { now: 10_001 }).strategy, "analyze");
});
