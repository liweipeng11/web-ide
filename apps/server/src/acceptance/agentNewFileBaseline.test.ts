import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runAgentRuntime } from "../agentRuntime.js";
import type { AgentContext } from "../agentToolTypes.js";
import { checkExistence } from "../existenceChecker/index.js";
import { createTaskSession, getTaskSession } from "../taskSessionStore.js";
import { finalizeTaskSession } from "../taskSessionFinalizer.js";
import { createVue2RouterFixture } from "../testing/vue2RouterFixture.js";
import { createTaskWorkflow, evaluateTaskWorkflowToolDecision } from "../taskWorkflow/index.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

function createBlockedAgentContext(projectPath: string): AgentContext {
  const mainPath = `${projectPath}/src/main.js`;
  return {
    userGoal: "新增 Vue 2 路由文件并接入 main.js",
    filesRead: [mainPath],
    searchQueries: ["router"],
    searchResultFiles: [mainPath],
    relevantFiles: [mainPath],
    negativeEvidence: [],
    patternSearchPerformed: true,
    patternCandidateFiles: [mainPath],
    existenceCheckPerformed: true,
    unresolvedExistenceChecks: ["./router", "@/views/createuserid.vue", "vue-router"],
    commandsRun: [],
    externalSources: []
  };
}

test("Vue 2 夹具在阶段 1 区分真实缺失、别名文件和已安装依赖", async (context) => {
  const fixture = await createVue2RouterFixture();
  context.after(fixture.cleanup);

  // 夹具自身先证明与开发者本机依赖隔离，并保持目标路由目录尚未创建。
  const packageJson = JSON.parse(await fs.readFile(path.join(fixture.projectRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.["vue-router"], "^3.6.5");
  assert.equal(await fs.stat(path.join(fixture.projectRoot, "node_modules", "vue-router", "package.json")).then(() => true), true);
  assert.equal(await fs.stat(path.join(fixture.projectRoot, "src", "views", "createuserid.vue")).then(() => true), true);
  assert.equal(await fs.stat(path.join(fixture.projectRoot, "src", "router")).then(() => true).catch(() => false), false);
  assert.doesNotMatch(await fs.readFile(path.join(fixture.projectRoot, "src", "main.js"), "utf8"), /from\s+["']\.\/router["']/);

  const result = await checkExistence(fixture.fixtureRoot, [
    { kind: "import", value: "./router", fromPath: `${fixture.projectPath}/src/main.js` },
    { kind: "import", value: "@/views/createuserid.vue", fromPath: `${fixture.projectPath}/src/main.js` },
    { kind: "import", value: "vue-router", fromPath: `${fixture.projectPath}/src/router/index.js` }
  ]);

  assert.deepEqual(result.checks.map((check) => check.resolution.status), [
    "truly_missing",
    "existing",
    "dependency_installed"
  ]);
  assert.deepEqual(
    result.checks.map((check) => check.status),
    ["missing", "exists", "exists"],
    "旧三态适配器应继续供阶段 1 之前的工作流兼容使用"
  );
});

test("未解析引用通过 references_resolved 门禁阻止 proposePatch", async (context) => {
  const fixture = await createVue2RouterFixture();
  context.after(fixture.cleanup);
  const agentContext = createBlockedAgentContext(fixture.projectPath);
  const workflow = createTaskWorkflow(agentContext.userGoal);

  const decision = evaluateTaskWorkflowToolDecision({
    workflow,
    toolName: "proposePatch",
    agentContext,
    availableTools: new Set(["readFile", "findSimilarPatterns", "checkExistence", "proposePatch"])
  });

  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missingEvidence, ["references_resolved"]);
  assert.match(decision.reason || "", /Resolve missing or ambiguous references before editing/);
});

test("编辑型 Runtime 在零补丁和零文件变更时返回 incomplete", async () => {
  const result = await runAgentRuntime({
    userRequest: "创建 src/router/index.js 并修改 src/main.js",
    mode: "act",
    contextBudgetEnabled: false,
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "当前无法自动修改，请手动创建路由文件。" } }]
    }),
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.generatedPatchIds, []);
  assert.equal(result.messages.some((message) => message.role === "tool"), false);
});

test("任务会话允许 filesChanged 为空时持久化 incomplete", async (context) => {
  const fixture = await createVue2RouterFixture();
  context.after(fixture.cleanup);
  await setWorkspaceRoot(fixture.fixtureRoot, { persist: false });

  const session = await createTaskSession("新增 Vue 2 路由");
  const completed = await finalizeTaskSession({ taskSessionId: session.id, runtimeResult: { status: "incomplete" }, source: "agent_runtime" });
  const persisted = await getTaskSession(session.id);

  assert.equal(completed?.status, "incomplete");
  assert.equal(persisted.status, "incomplete");
  assert.deepEqual(persisted.filesChanged, []);
});
