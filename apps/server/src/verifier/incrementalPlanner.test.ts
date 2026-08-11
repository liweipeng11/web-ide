import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ImpactAnalysisResult } from "../impactAnalyzer/index.js";
import type { ProjectAnalysis } from "../projectAnalyzerTypes.js";
import { planIncrementalVerification } from "./incrementalPlanner.js";
import type { VerificationCommand } from "./types.js";

function analysis(): ProjectAnalysis {
  return {
    packageManager: {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      workspaceFile: "pnpm-workspace.yaml",
      packageJsonFiles: ["package.json", "apps/server/package.json", "apps/web/package.json"]
    },
    techStack: { languages: ["typescript"], frameworks: [], buildTools: [], lintTools: [], typeSystems: ["typescript"], configFiles: [] },
    structure: { rootEntries: [], sourceDirectories: [], workspacePackages: ["apps/server", "apps/web"] },
    testSystem: { tools: ["node:test"], configFiles: [], testFiles: ["apps/server/src/userService.test.ts"], hasTests: true },
    validationCommands: [],
    highRiskDirectories: []
  };
}

function command(packageDirectory: string, name: string, stage: VerificationCommand["stage"]): VerificationCommand {
  return {
    name,
    command: packageDirectory ? `pnpm --dir ${packageDirectory} ${name}` : `pnpm ${name}`,
    source: packageDirectory ? `${packageDirectory}/package.json` : "package.json",
    reason: `${name} 脚本`,
    stage
  };
}

function impact(overrides: Partial<ImpactAnalysisResult> = {}): ImpactAnalysisResult {
  return {
    changes: [],
    impactedFiles: [{ filePath: "apps/server/src/userController.ts", depth: 1, impact: "direct", categories: ["implementation"], reasons: [], affectedSymbols: [] }],
    relatedTests: ["apps/server/src/userService.test.ts"],
    boundaryFiles: [],
    risk: { level: "low", score: 1, factors: [] },
    diagnostics: [],
    complete: true,
    truncated: false,
    indexedFileCount: 3,
    indexedSymbolCount: 2,
    unresolvedReferenceCount: 0,
    indexedUnresolvedReferenceCount: 0,
    ...overrides
  };
}

test("根据改动文件仅选择相关包命令并映射测试", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-verifier-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "apps/server/src"), { recursive: true });
  await fs.writeFile(path.join(root, "apps/server/src/userService.ts"), "export const user = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "apps/server/package.json"), JSON.stringify({ scripts: { test: "tsx --test src/**/*.test.ts" } }), "utf8");
  const commands = [
    command("apps/server", "typecheck", "typecheck"),
    command("apps/server", "test", "test"),
    command("apps/server", "build", "build"),
    command("apps/web", "typecheck", "typecheck"),
    command("apps/web", "test", "test")
  ];

  const plan = await planIncrementalVerification(root, analysis(), commands, { changedFiles: ["apps/server/src/userService.ts"] }, { analyzeImpact: async () => impact() });

  assert.equal(plan.mode, "incremental");
  assert.deepEqual(plan.affectedPackages, ["apps/server"]);
  assert.deepEqual(plan.relatedTests, ["apps/server/src/userService.test.ts"]);
  assert.deepEqual(plan.commands.map((item) => item.command), ["pnpm --dir apps/server typecheck", "pnpm --dir apps/server exec tsx --test src/userService.test.ts"]);
  assert.equal(plan.buildRequired, false);
});

test("node --test 脚本保留包级命令而不生成 npm exec node", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-node-test-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "apps/server/src"), { recursive: true });
  await fs.writeFile(path.join(root, "apps/server/src/userService.ts"), "export const user = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "apps/server/package.json"), JSON.stringify({ scripts: { test: "node --test src/**/*.test.js" } }), "utf8");

  const plan = await planIncrementalVerification(
    root,
    analysis(),
    [command("apps/server", "test", "test")],
    { changedFiles: ["apps/server/src/userService.ts"] },
    { analyzeImpact: async () => impact() }
  );

  assert.deepEqual(plan.commands.map((item) => item.command), ["pnpm --dir apps/server test"]);
});

test("配置变更和构建失败类别会升级到包级 build", async () => {
  const commands = [command("apps/web", "typecheck", "typecheck"), command("apps/web", "build", "build")];
  const configPlan = await planIncrementalVerification("C:/workspace", analysis(), commands, { changedFiles: ["apps/web/vite.config.ts"] });
  const failurePlan = await planIncrementalVerification("C:/workspace", analysis(), commands, {
    changedFiles: ["apps/web/src/App.tsx"],
    failureCategories: ["build"]
  });

  assert.equal(configPlan.buildRequired, true);
  assert.ok(configPlan.commands.some((item) => item.stage === "build"));
  assert.equal(failurePlan.buildRequired, true);
});

test("影响分析不完整时明确退回包级验证", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "incremental-fallback-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "apps/server/src"), { recursive: true });
  await fs.writeFile(path.join(root, "apps/server/src/service.ts"), "export const value = 1;\n", "utf8");

  const plan = await planIncrementalVerification(
    root,
    analysis(),
    [command("apps/server", "test", "test")],
    { changedFiles: ["apps/server/src/service.ts"] },
    { analyzeImpact: async () => impact({ complete: false, diagnostics: ["索引已截断"] }) }
  );

  assert.equal(plan.mode, "package_fallback");
  assert.deepEqual(plan.diagnostics, ["索引已截断"]);
  assert.deepEqual(plan.commands.map((item) => item.command), ["pnpm --dir apps/server test"]);
});

test("存在基础 test 脚本时不重复执行同包 test 子脚本", async () => {
  const commands = [
    command("apps/server", "test", "test"),
    command("apps/server", "test:unit", "test"),
    command("apps/server", "test:integration", "test")
  ];

  const plan = await planIncrementalVerification("C:/workspace", analysis(), commands, { changedFiles: ["apps/server/package.json"] });

  assert.deepEqual(plan.commands.map((item) => item.command), ["pnpm --dir apps/server test"]);
});

test("相关包没有脚本时不执行其他包的验证命令", async () => {
  const commands = [command("apps/server", "typecheck", "typecheck"), command("apps/server", "test", "test")];

  const plan = await planIncrementalVerification("C:/workspace", analysis(), commands, { changedFiles: ["apps/web/src/App.tsx"] });

  assert.deepEqual(plan.affectedPackages, ["apps/web"]);
  assert.deepEqual(plan.commands, []);
  assert.match(plan.diagnostics.join("\n"), /未执行其他包的无关命令/);
});
