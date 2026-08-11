import test from "node:test";
import assert from "node:assert/strict";
import type { ProjectAnalysis } from "../../projectAnalyzerTypes.js";
import type { RuntimeToolExecutionContext } from "../../runtime/contracts.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import type { RunVerificationOptions, VerificationReport } from "../../verifier/types.js";
import { createTesterRuntimeTools } from "./testerTools.js";

const analysis: ProjectAnalysis = {
  packageManager: { name: "pnpm", lockfile: "pnpm-lock.yaml", workspaceFile: null, packageJsonFiles: ["package.json"] },
  techStack: { languages: ["typescript"], frameworks: [], buildTools: [], lintTools: [], typeSystems: ["typescript"], configFiles: [] },
  structure: { rootEntries: ["package.json"], sourceDirectories: ["src", "tests"], workspacePackages: [] },
  testSystem: {
    tools: ["node:test"],
    configFiles: [],
    testFiles: ["tests/auth/rate-limit.test.ts", "tests/payment/payment.test.ts"],
    hasTests: true
  },
  validationCommands: [],
  highRiskDirectories: []
};

const report: VerificationReport = {
  status: "success",
  plannedCommands: [],
  plan: {
    mode: "incremental",
    commands: [],
    changedFiles: [],
    affectedPackages: [],
    relatedTests: [],
    buildRequired: false,
    reasons: [],
    diagnostics: []
  },
  executions: []
};

function context(readScope = ["src/**", "tests/auth/**", "package.json"]): RuntimeToolExecutionContext {
  return {
    agentId: "tester",
    task: {
      taskId: "T3",
      goal: "验证认证限流",
      context: {},
      constraints: [],
      acceptanceCriteria: ["第 6 次返回 429"],
      readScope,
      writeScope: [],
      allowedTools: ["run_verification"]
    }
  };
}

test("Tester 工具只把 testScope 命中的已扫描测试交给增量验证器", async () => {
  let received: RunVerificationOptions | undefined;
  const tool = createTesterRuntimeTools({
    getWorkspaceRoot: () => "C:/workspace",
    analyzeProject: async () => analysis,
    runVerification: async (options) => {
      received = options;
      return report;
    }
  })[0];

  await tool.execute({ changedFiles: ["src/auth.ts"], testScope: ["tests/auth/**"] }, context());

  assert.deepEqual(received?.changedFiles, ["src/auth.ts", "tests/auth/rate-limit.test.ts"]);
  assert.equal(received?.confirmed, false);
});

test("Tester 工具拒绝 readScope 外的改动文件和测试范围", async () => {
  const tool = createTesterRuntimeTools({
    getWorkspaceRoot: () => "C:/workspace",
    analyzeProject: async () => analysis,
    runVerification: async () => report
  })[0];

  await assert.rejects(
    () => tool.execute({ changedFiles: ["private/secret.ts"], testScope: ["tests/auth/**"] }, context()),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "SCOPE_VIOLATION")
  );
  await assert.rejects(
    () => tool.execute({ changedFiles: ["src/auth.ts"], testScope: ["tests/payment/**"] }, context()),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "SCOPE_VIOLATION")
  );
});

test("Tester 工具拒绝工作区逃逸路径且不会执行验证", async () => {
  let called = false;
  const tool = createTesterRuntimeTools({
    getWorkspaceRoot: () => "C:/workspace",
    analyzeProject: async () => analysis,
    runVerification: async () => {
      called = true;
      return report;
    }
  })[0];

  await assert.rejects(
    () => tool.execute({ changedFiles: ["../secret.ts"], testScope: ["tests/**"] }, context()),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "SCOPE_VIOLATION")
  );
  assert.equal(called, false);
});

test("testScope 未命中已识别测试时阻塞且不回退到无关包级测试", async () => {
  let called = false;
  const tool = createTesterRuntimeTools({
    getWorkspaceRoot: () => "C:/workspace",
    analyzeProject: async () => analysis,
    runVerification: async () => {
      called = true;
      return report;
    }
  })[0];

  const result = await tool.execute(
    { changedFiles: ["src/auth.ts"], testScope: ["tests/unknown/**"] },
    context(["src/**", "tests/**", "package.json"])
  ) as VerificationReport;

  assert.equal(result.status, "no_commands");
  assert.match(result.plan.diagnostics[0], /未命中测试文件/);
  assert.equal(called, false);
});

test("Runtime 权限层拒绝 Tester 调用生产代码编辑工具", () => {
  const task = context().task;
  const permissions = new PermissionManager([{ agentId: "tester", allowedTools: ["run_verification"] }]);

  assert.throws(
    () => permissions.checkTool("tester", task, {
      name: "edit_file",
      description: "编辑生产代码",
      effect: "write",
      getTargetPaths: (args) => [String(args.filePath)],
      execute: async () => null
    }, { filePath: "src/auth.ts" }),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "PERMISSION_DENIED")
  );
});
