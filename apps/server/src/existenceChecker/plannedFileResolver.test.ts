import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { checkCodeImports, checkPatchImports } from "./existenceChecker.js";
import { buildPlannedFileGraph } from "./plannedFileResolver.js";
import { createVue2RouterFixture } from "../testing/vue2RouterFixture.js";

async function createWorkspace(context: TestContext) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planned-files-"));
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  return workspaceRoot;
}

test("Vue 2 双文件补丁通过虚拟文件图解析计划新增的目录 index", async (context) => {
  const fixture = await createVue2RouterFixture();
  context.after(fixture.cleanup);
  const mainPath = `${fixture.projectPath}/src/main.js`;
  const routerPath = `${fixture.projectPath}/src/router/index.js`;
  const mainContent = [
    "import Vue from \"vue\";",
    "import App from \"./App.vue\";",
    "import router from \"./router\";",
    "new Vue({ router, render: (createElement) => createElement(App) }).$mount(\"#app\");",
    ""
  ].join("\n");
  const routerContent = [
    "import VueRouter from \"vue-router\";",
    "import CreateUserId from \"@/views/createuserid.vue\";",
    "export default new VueRouter({ routes: [{ path: \"/createUserId\", component: CreateUserId }] });",
    ""
  ].join("\n");
  const files = [
    { path: routerPath, status: "create" as const, newContent: routerContent },
    { path: mainPath, status: "modify" as const, newContent: mainContent }
  ];

  const graph = await buildPlannedFileGraph(
    fixture.fixtureRoot,
    files.map((file) => ({ filePath: file.path, changeKind: file.status, content: file.newContent }))
  );
  const mainImports = await checkCodeImports(fixture.fixtureRoot, mainContent, mainPath, { plannedFileGraph: graph });
  const validation = await checkPatchImports(fixture.fixtureRoot, files, graph);

  assert.equal(
    mainImports.result.checks.find((check) => check.target.value === "./router")?.resolution.status,
    "planned_create"
  );
  assert.equal(
    validation.fileResults
      .find(({ file }) => file.path === routerPath)
      ?.result.checks.find((check) => check.target.value === "vue-router")
      ?.resolution.status,
    "dependency_installed"
  );
  assert.equal(
    validation.fileResults
      .find(({ file }) => file.path === routerPath)
      ?.result.checks.find((check) => check.target.value === "@/views/createuserid.vue")
      ?.resolution.status,
    "existing"
  );
  assert.deepEqual(validation.unresolved, []);
  await assert.rejects(fs.stat(path.join(fixture.fixtureRoot, routerPath)));
});

test("计划新增文件可以互相引用，真实缺失引用仍会阻断补丁", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  const files = [
    { path: "src/entry.ts", status: "create" as const, newContent: "import { value } from \"./value\";\nexport { value };\n" },
    { path: "src/value.ts", status: "create" as const, newContent: "export const value = 1;\n" }
  ];

  const valid = await checkPatchImports(workspaceRoot, files);
  const invalid = await checkPatchImports(workspaceRoot, [
    ...files,
    { path: "src/broken.ts", status: "create", newContent: "import \"./not-created\";\n" }
  ]);

  assert.equal(valid.fileResults[0].result.checks[0].resolution.status, "planned_create");
  assert.deepEqual(valid.unresolved, []);
  assert.equal(invalid.unresolved.length, 1);
  assert.equal(invalid.unresolved[0].check.resolution.status, "truly_missing");
});

test("文件计划拒绝冲突、磁盘状态不符和越界路径", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "existing.ts"), "export {};\n", "utf8");

  await assert.rejects(
    buildPlannedFileGraph(workspaceRoot, [
      { filePath: "src/new.ts", changeKind: "create" },
      { filePath: "src/new.ts", changeKind: "delete" }
    ]),
    /同一路径/
  );
  await assert.rejects(
    buildPlannedFileGraph(workspaceRoot, [{ filePath: "src/existing.ts", changeKind: "create" }]),
    /已经存在/
  );
  await assert.rejects(
    buildPlannedFileGraph(workspaceRoot, [{ filePath: "src/missing.ts", changeKind: "modify" }]),
    /不是已存在文件/
  );
  await assert.rejects(
    buildPlannedFileGraph(workspaceRoot, [{ filePath: "../outside.ts", changeKind: "create" }]),
    /不能包含 \.\.|越出工作区/
  );
});

test("计划删除的文件不再属于补丁后的可解析候选", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "removed.ts"), "export const removed = true;\n", "utf8");
  const graph = await buildPlannedFileGraph(workspaceRoot, [{ filePath: "src/removed.ts", changeKind: "delete" }]);

  const result = await checkCodeImports(workspaceRoot, "import \"./removed\";\n", "src/entry.ts", {
    plannedFileGraph: graph
  });

  assert.equal(result.result.checks[0].resolution.status, "truly_missing");
});
