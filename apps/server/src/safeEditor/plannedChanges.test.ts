import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchAgentToolDefinitions, resolveProposedModificationPlan } from "../agentPatchTools.js";
import { buildEditScope, validatePatchesAgainstEditScope } from "../editScope.js";
import {
  createStructuredModificationPlan,
  validatePatchSubsetOfPlan,
  validateStructuredModificationPlan,
  type PlannedChange
} from "./index.js";

async function createWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "safe-editor-planned-changes-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(workspaceRoot, "src/main.js"), "export const app = {};\n", "utf8"),
    fs.writeFile(path.join(workspaceRoot, "src/obsolete.js"), "export const obsolete = true;\n", "utf8"),
    fs.writeFile(path.join(workspaceRoot, "src/legacy.js"), "export const legacy = true;\n", "utf8"),
    fs.writeFile(path.join(workspaceRoot, "src/api.js"), "export function load() {}\n", "utf8")
  ]);
  return workspaceRoot;
}

test("单文件和多文件计划支持阶段 2 的全部变更类型", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const files: PlannedChange[] = [
    { filePath: "src/router.js", changeKind: "create", reason: "新增路由配置" },
    { filePath: "src/main.js", changeKind: "modify", reason: "注入路由" },
    { filePath: "src/obsolete.js", changeKind: "delete", reason: "移除废弃入口" },
    { filePath: "src/legacy.js", changeKind: "rename", reason: "统一模块命名" },
    { filePath: "src/api.js", changeKind: "signature", symbolName: "load", reason: "调整公开参数" }
  ];
  const plan = await validateStructuredModificationPlan(
    workspaceRoot,
    createStructuredModificationPlan({ taskDescription: "更新路由模块", files })
  );

  assert.deepEqual(plan.files, files);
  assert.equal((await validateStructuredModificationPlan(workspaceRoot, createStructuredModificationPlan({
    taskDescription: "单文件修改",
    files: [files[1]]
  }))).files.length, 1);
});

test("空理由、越界路径和与磁盘状态冲突的计划会被拒绝", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

  assert.throws(() => createStructuredModificationPlan({
    taskDescription: "空理由",
    files: [{ filePath: "src/main.js", changeKind: "modify", reason: "  " }]
  }), /修改原因/);
  assert.throws(() => createStructuredModificationPlan({
    taskDescription: "越界",
    files: [{ filePath: "../outside.js", changeKind: "create", reason: "不允许越界" }]
  }), /非法工作区路径/);
  await assert.rejects(() => validateStructuredModificationPlan(workspaceRoot, createStructuredModificationPlan({
    taskDescription: "错误创建状态",
    files: [{ filePath: "src/main.js", changeKind: "create", reason: "错误覆盖" }]
  })), /已经存在/);
  await assert.rejects(() => validateStructuredModificationPlan(workspaceRoot, createStructuredModificationPlan({
    taskDescription: "错误修改状态",
    files: [{ filePath: "src/missing.js", changeKind: "modify", reason: "目标不存在" }]
  })), /必须是已存在文件/);
});

test("候选补丁必须是计划子集且变更状态必须匹配", () => {
  const plannedChanges: PlannedChange[] = [
    { filePath: "src/main.js", changeKind: "modify", reason: "更新入口" },
    { filePath: "src/router.js", changeKind: "create", reason: "新增路由" }
  ];
  assert.equal(validatePatchSubsetOfPlan([
    { filePath: "src/main.js", status: "modify" },
    { filePath: "src/router.js", status: "create" }
  ], plannedChanges).ok, true);
  assert.deepEqual(validatePatchSubsetOfPlan([
    { filePath: "src/unrelated.js", status: "modify" },
    { filePath: "src/router.js", status: "modify" }
  ], plannedChanges).blockedFiles, ["src/unrelated.js", "src/router.js"]);

  const scope = buildEditScope({ plannedChanges });
  const result = validatePatchesAgainstEditScope([{
    filePath: "src/unrelated.js",
    status: "modify",
    oldContent: "old",
    newContent: "new",
    summary: "计划外修改"
  }], scope);
  assert.equal(result.ok, false);
});

test("proposePatch 暴露 plannedChanges 契约并在生成前验证文件状态", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const definition = patchAgentToolDefinitions.find((tool) => tool.name === "proposePatch");
  const parameters = definition?.parameters as { properties?: Record<string, unknown> } | undefined;
  const plannedChangesSchema = parameters?.properties?.plannedChanges as { items?: { required?: string[] } } | undefined;

  assert.ok(plannedChangesSchema);
  assert.deepEqual(plannedChangesSchema.items?.required, ["filePath", "changeKind", "reason"]);

  const plan = await resolveProposedModificationPlan({
    plannedChanges: [
      { filePath: "src/main.js", changeKind: "modify", reason: "注入路由" },
      { filePath: "src/router.js", changeKind: "create", reason: "新增路由配置" }
    ]
  }, undefined, workspaceRoot, "新增 Vue Router");
  assert.deepEqual(plan.files.map((file) => file.filePath), ["src/main.js", "src/router.js"]);
});
