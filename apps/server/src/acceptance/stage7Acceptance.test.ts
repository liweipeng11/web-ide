import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAgentRuntime } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { AgentToolDefinition } from "../agentToolTypes.js";
import type { AgentStep } from "../types.js";

const execAsync = promisify(exec);
const fixtureRoot = fileURLToPath(new URL("../fixtures/vue2-router-missing", import.meta.url));

function createTool(
  name: string,
  execute: AgentToolDefinition["execute"]
): AgentToolDefinition {
  return {
    name,
    description: `阶段七验收工具：${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute,
    summarize(result, cached) {
      return { cached, ...(result && typeof result === "object" ? result : { result }) };
    }
  };
}

test("阶段七：Vue 2 路由缺失场景在预算内生成三文件补丁并完成构建", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "web-ide-stage7-"));
  const steps: AgentStep[] = [];
  const proposedFiles: string[] = [];
  const toolNames: string[] = [];
  let buildSucceeded = false;

  await cp(fixtureRoot, workspace, { recursive: true });

  const registry = createAgentToolRegistry([
    createTool("inspectProject", async () => {
      toolNames.push("inspectProject");
      const packageJson = JSON.parse(await readFile(join(workspace, "package.json"), "utf8")) as { dependencies: Record<string, string> };
      return { framework: "vue2", vueRouterVersion: packageJson.dependencies["vue-router"] };
    }),
    createTool("searchFilesByName", async (args, runtime) => {
      toolNames.push("searchFilesByName");
      const query = String(args.query || "");
      runtime.agentContext.negativeEvidence?.push({
        kind: "path_absent",
        query,
        scope: "src",
        sourceTool: "searchFilesByName",
        exhaustive: true,
        createdAt: Date.now()
      });
      return { query, searchedPath: "src", matches: [], exhaustive: true, conclusion: "target_absent" };
    }),
    createTool("proposePatch", async (args, runtime) => {
      toolNames.push("proposePatch");
      const changes = Array.isArray(args.changes) ? args.changes as Array<{ path: string; content: string }> : [];
      assert.equal(changes.length, 3);
      for (const change of changes) {
        const target = join(workspace, change.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, change.content, "utf8");
        proposedFiles.push(change.path);
      }
      runtime.generatedPatchIds?.push("stage7-vue2-router-patch");
      // Fixture 工具实际写入了文件，必须显式返回 applied，供完成门禁记录可审计变更证据。
      return { applied: true, patchId: "stage7-vue2-router-patch", files: changes.map((change) => change.path) };
    }),
    createTool("validateFixtureBuild", async () => {
      toolNames.push("validateFixtureBuild");
      // 使用 Fixture 自带的 build 脚本做真实语法验证，不依赖生产接口或外部服务。
      const { stdout, stderr } = await execAsync("pnpm run build", { cwd: workspace });
      buildSucceeded = true;
      return { status: "success", output: `${stdout}${stderr}`.trim() };
    })
  ]);

  const routerContent = [
    'import Vue from "vue"',
    'import VueRouter from "vue-router"',
    'import CreateUserId from "../views/createuserid.vue"',
    "",
    "Vue.use(VueRouter)",
    "",
    "export default new VueRouter({",
    '  mode: "history",',
    "  routes: [",
    '    { path: "/", redirect: "/create-user-id" },',
    '    { path: "/create-user-id", name: "create-user-id", component: CreateUserId }',
    "  ]",
    "})",
    ""
  ].join("\n");
  const mainContent = [
    'import Vue from "vue"',
    'import App from "./App.vue"',
    'import router from "./router"',
    "",
    "Vue.config.productionTip = false",
    "",
    "new Vue({",
    "  router,",
    "  render: (h) => h(App)",
    '}).$mount("#app")',
    ""
  ].join("\n");
  const appContent = [
    "<template>",
    '  <main id="app">',
    "    <h1>用户管理</h1>",
    "    <nav><router-link to=\"/create-user-id\">创建用户 ID</router-link></nav>",
    "    <router-view />",
    "  </main>",
    "</template>",
    "",
    "<script>",
    "export default {",
    '  name: "App"',
    "}",
    "</script>",
    ""
  ].join("\n");
  const responses = [
    { name: "inspectProject", args: {} },
    { name: "searchFilesByName", args: { query: "router", path: "src" } },
    {
      name: "proposePatch",
      args: {
        changes: [
          { path: "src/router/index.js", content: routerContent },
          { path: "src/main.js", content: mainContent },
          { path: "src/App.vue", content: appContent }
        ]
      }
    },
    { name: "validateFixtureBuild", args: {} }
  ];
  let modelRound = 0;

  try {
    const result = await runAgentRuntime({
      userRequest: "为 Vue 2 项目接入 vue-router 3，创建缺失路由并完成构建验证",
      registry,
      maxSteps: 10,
      convergenceRemainingSteps: 3,
      forceFinalRemainingSteps: 1,
      maxNoProgressSteps: 3,
      recoveryAttempts: 1,
      contextBudgetEnabled: false,
      onAgentStep(step) {
        steps.push(step);
      },
      requestCompletion: async () => {
        const next = responses[modelRound];
        modelRound += 1;
        if (!next) {
          return {
            choices: [{
              message: {
                role: "assistant",
                content: "已识别 Vue Router 3，确认路由文件缺失；已创建 router/index.js、修改 main.js 和 App.vue，并完成 build 验证。"
              }
            }]
          };
        }
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `stage7-call-${modelRound}`,
                type: "function",
                function: { name: next.name, arguments: JSON.stringify(next.args) }
              }]
            }
          }]
        };
      }
    });

    assert.equal(result.status, "completed");
    assert.ok(modelRound < 10);
    assert.deepEqual(toolNames, ["inspectProject", "searchFilesByName", "proposePatch", "validateFixtureBuild"]);
    assert.equal(buildSucceeded, true);
    assert.deepEqual(proposedFiles.sort(), ["src/App.vue", "src/main.js", "src/router/index.js"].sort());
    assert.match(await readFile(join(workspace, "src/router/index.js"), "utf8"), /VueRouter/);
    assert.match(await readFile(join(workspace, "src/main.js"), "utf8"), /router,/);
    assert.match(await readFile(join(workspace, "src/App.vue"), "utf8"), /router-view/);
    assert.match(result.content, /build 验证/);
    assert.equal(steps.some((step) => step.type === "strategy" && step.event === "create_intent"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
