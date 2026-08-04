import assert from "node:assert/strict";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { evaluateAgentCompletion } from "../agentCompletionPolicy.js";
import { validateAgentGeneratedPatchImports } from "../agentPatchTools.js";
import { applyPendingPatch } from "../patchApplyService.js";
import { clearPendingPatches, createPendingPatch } from "../patchStore.js";
import {
  advanceTaskPlanProgress,
  createTaskSession,
  deleteTaskSession,
  getTaskSession,
  setTaskPlanItems,
} from "../taskSessionStore.js";
import { finalizeTaskSession } from "../taskSessionFinalizer.js";
import { createVue2RouterFixture } from "../testing/vue2RouterFixture.js";
import type { PatchFileChange } from "../types.js";
import { checkExistence } from "../existenceChecker/index.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

const execAsync = promisify(exec);

function createPatchFile(input: {
  path: string;
  status: PatchFileChange["status"];
  oldContent: string;
  newContent: string;
  summary: string;
}): PatchFileChange {
  return {
    ...input,
    filePath: input.path,
    diffHtml: ""
  };
}

test("阶段七：原始 Vue 2 路由任务完成双文件补丁、审批应用、构建与 UTF-8 会话收口", async (context) => {
  const fixture = await createVue2RouterFixture();
  context.after(async () => {
    clearPendingPatches();
    await fixture.cleanup();
  });
  await setWorkspaceRoot(fixture.fixtureRoot, { persist: false });

  const projectPrefix = fixture.projectPath.replace(/\\/g, "/");
  const mainPath = `${projectPrefix}/src/main.js`;
  const routerPath = `${projectPrefix}/src/router/index.js`;
  const initialReferences = await checkExistence(fixture.fixtureRoot, [
    { kind: "import", value: "./router", fromPath: mainPath },
    { kind: "import", value: "@/views/createuserid.vue", fromPath: mainPath },
    { kind: "import", value: "vue-router", fromPath: routerPath }
  ]);
  assert.deepEqual(
    initialReferences.checks.map((check) => check.resolution.status),
    ["truly_missing", "existing", "dependency_installed"]
  );

  const oldMainContent = await fs.readFile(path.join(fixture.projectRoot, "src", "main.js"), "utf8");
  const routerContent = [
    'import Vue from "vue";',
    'import VueRouter from "vue-router";',
    'import CreateUserId from "@/views/createuserid.vue";',
    "",
    "Vue.use(VueRouter);",
    "",
    "export default new VueRouter({",
    "  routes: [",
    '    { path: "/createUserId", name: "CreateUserId", component: CreateUserId },',
    '    { path: "/", redirect: "/createUserId" }',
    "  ]",
    "});",
    ""
  ].join("\n");
  const mainContent = oldMainContent
    .replace('import App from "./App.vue";', 'import App from "./App.vue";\nimport router from "./router";')
    .replace("new Vue({\n  render:", "new Vue({\n  router,\n  render:");
  const files = [
    createPatchFile({
      path: routerPath,
      status: "create",
      oldContent: "",
      newContent: routerContent,
      summary: "创建 Vue Router 配置"
    }),
    createPatchFile({
      path: mainPath,
      status: "modify",
      oldContent: oldMainContent,
      newContent: mainContent,
      summary: "在 Vue 实例中接入 Router"
    })
  ];

  const importValidation = await validateAgentGeneratedPatchImports(fixture.fixtureRoot, files);
  assert.equal(importValidation.unresolved.length, 0);
  const mainValidation = importValidation.fileResults.find((item) => item.file.path === mainPath);
  const routerReference = mainValidation?.result.checks.find((check) => check.target.value === "./router");
  assert.equal(routerReference?.resolution.status, "planned_create");

  const session = await createTaskSession("将 createuserid.vue 添加到 /createUserId 路由，并将 / 重定向到该路由");
  context.after(() => deleteTaskSession(session.id).catch(() => undefined));
  await setTaskPlanItems(session.id, [
    { workflowStepId: "analyze-project", title: "分析项目与需求" },
    { workflowStepId: "find-patterns", title: "读取相关文件" },
    { workflowStepId: "plan-files", title: "确认双文件计划" },
    { workflowStepId: "implement", title: "生成并应用补丁" },
    { workflowStepId: "validate", title: "执行构建验证" },
    { workflowStepId: "summarize", title: "完成验收" }
  ]);
  const patch = createPendingPatch(files, session.id, ["pnpm run build"]);
  await advanceTaskPlanProgress(session.id, "patch_generated");

  const awaitingDecision = evaluateAgentCompletion({
    evidence: {
      workflowType: "feature",
      mutationExpected: true,
      generatedPatchCount: 1,
      pendingPatchCount: 1,
      changedFileCount: 0,
      pendingPlanCount: 2,
      blockedPlanCount: 0,
      validationStatus: "not_run",
      pendingApprovalCount: 0,
      activeCommandCount: 0,
      failedToolCallCount: 0
    },
    finalContent: "已生成双文件补丁，等待审批。",
    recoveryAttempted: false,
    editingToolsAvailable: true
  });
  assert.equal(awaitingDecision.status, "awaiting_approval");

  const applied = await applyPendingPatch({ patchId: patch.patchId });
  assert.deepEqual(applied.files.map((file) => file.path).sort(), [mainPath, routerPath].sort());
  await execAsync("pnpm run build", { cwd: fixture.projectRoot });
  await advanceTaskPlanProgress(session.id, "validation_success");
  await finalizeTaskSession({
    taskSessionId: session.id,
    source: "agent_runtime",
    runtimeResult: {
      status: "completed",
      statusReason: "双文件补丁已审批应用并通过构建验证。",
      completionEvidence: {
      workflowType: "feature",
      mutationExpected: true,
      generatedPatchCount: 1,
      pendingPatchCount: 1,
      changedFileCount: 2,
      pendingPlanCount: 0,
      blockedPlanCount: 0,
      validationStatus: "passed",
      pendingApprovalCount: 0,
      activeCommandCount: 0,
      failedToolCallCount: 0
      }
    }
  });

  const finalMain = await fs.readFile(path.join(fixture.projectRoot, "src", "main.js"), "utf8");
  const finalRouter = await fs.readFile(path.join(fixture.projectRoot, "src", "router", "index.js"), "utf8");
  assert.match(finalMain, /import router from ["']\.\/router["']/);
  assert.match(finalMain, /new Vue\(\{\s*router,/s);
  assert.match(finalRouter, /path:\s*["']\/createUserId["']/);
  assert.match(finalRouter, /redirect:\s*["']\/createUserId["']/);
  assert.match(finalRouter, /@\/views\/createuserid\.vue/);

  const persisted = await getTaskSession(session.id);
  assert.equal(persisted.status, "success");
  assert.equal(persisted.runtimeStatus, "completed");
  assert.deepEqual(persisted.filesChanged.sort(), [mainPath, routerPath].sort());

  // 直接读取项目运行目录中的原始文件，确认中文内容是合法 UTF-8 JSON。
  const sessionPath = path.join(
    fixture.fixtureRoot,
    ".mini-ai",
    "state",
    "runtime",
    "task-sessions",
    `${session.id}.json`
  );
  const rawSession = await fs.readFile(sessionPath, "utf8");
  assert.doesNotThrow(() => JSON.parse(rawSession));
  assert.match(rawSession, /双文件补丁已审批应用并通过构建验证/);
  assert.equal(rawSession.includes("\uFFFD"), false);
});

test("阶段七：零交付物不能完成，真实缺失与工作区越界仍保持阻断", async () => {
  const fixture = await createVue2RouterFixture();
  try {
    const zeroDelivery = evaluateAgentCompletion({
      evidence: {
        workflowType: "feature",
        mutationExpected: true,
        generatedPatchCount: 0,
        changedFileCount: 0,
        pendingPlanCount: 0,
        blockedPlanCount: 0,
        validationStatus: "not_run",
        pendingApprovalCount: 0,
        activeCommandCount: 0,
        failedToolCallCount: 0
      },
      finalContent: "已经完成。",
      recoveryAttempted: true,
      editingToolsAvailable: true
    });
    assert.equal(zeroDelivery.status, "incomplete");

    const checks = await checkExistence(fixture.fixtureRoot, [
      {
        kind: "import",
        value: "./never-created",
        fromPath: `${fixture.projectPath}/src/main.js`
      },
      {
        kind: "import",
        value: "../../../outside.js",
        fromPath: `${fixture.projectPath}/src/main.js`
      }
    ]);
    assert.deepEqual(checks.checks.map((check) => check.resolution.blocking), [true, true]);
    assert.deepEqual(checks.checks.map((check) => check.resolution.status), ["truly_missing", "unknown"]);
  } finally {
    await fixture.cleanup();
  }
});
