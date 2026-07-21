import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createProjectMemoryTask, createProjectMemoryTestWorkspace } from "./fixtures/projectMemoryV2.fixture.js";
import { readProjectMemory } from "./projectMemoryStore.js";
import { getProjectMemory, refreshProjectMemoryAnalysis, synchronizeProjectMemoryWithTasks, updateProjectMemory } from "./projectMemoryService.js";

test("首次读取会扫描项目并持久化 Project Memory", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const memory = await getProjectMemory({ workspaceRoot, sessions: [] });

  assert.equal(memory.techStack.packageManager, "pnpm");
  assert.ok(memory.techStack.frameworks.includes("react"));
  assert.match(memory.projectSummary, /pnpm/);
  assert.deepEqual(await readProjectMemory(workspaceRoot), memory);
  assert.equal(memory.projectSummarySource, "generated");
});

test("局部更新保留自动字段并对重复约定去重", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  await getProjectMemory({ workspaceRoot, sessions: [] });

  const updated = await updateProjectMemory(
    {
      projectSummary: "一个用于验证长期记忆的项目",
      conventions: ["使用 pnpm", "使用 pnpm", "新增代码写中文注释"],
      currentGoals: ["完成 Project Memory"]
    },
    workspaceRoot
  );

  assert.equal(updated.projectSummary, "一个用于验证长期记忆的项目");
  assert.equal(updated.projectSummarySource, "manual");
  assert.deepEqual(updated.conventions, ["使用 pnpm", "新增代码写中文注释"]);
  assert.deepEqual(updated.currentGoals, ["完成 Project Memory"]);
  assert.ok(updated.techStack.frameworks.includes("react"));
});

test("并发局部更新不会互相覆盖不同字段", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  await getProjectMemory({ workspaceRoot, sessions: [] });

  await Promise.all([
    updateProjectMemory({ conventions: ["统一使用 pnpm"] }, workspaceRoot),
    updateProjectMemory({ confirmedRisks: ["生成目录不可直接修改"] }, workspaceRoot)
  ]);
  const memory = await getProjectMemory({ workspaceRoot, sessions: [] });

  assert.deepEqual(memory.conventions, ["统一使用 pnpm"]);
  assert.deepEqual(memory.confirmedRisks, ["生成目录不可直接修改"]);
});

test("任务历史会同步最近改动和未完成事项并限制数量", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const base = await getProjectMemory({ workspaceRoot, sessions: [], syncTasks: false });
  const sessions = Array.from({ length: 50 }, (_, index) =>
    createProjectMemoryTask({
      id: `task-${index}`,
      userGoal: `任务 ${index}`,
      status: index % 2 === 0 ? "success" : "failed",
      filesChanged: index % 2 === 0 ? [`src/file-${index}.ts`] : [],
      updatedAt: 1_000 + index
    })
  );

  const synchronized = synchronizeProjectMemoryWithTasks(base, sessions);

  assert.equal(synchronized.recentChanges.length, 20);
  assert.equal(synchronized.pendingItems.length, 20);
  assert.equal(synchronized.recentChanges[0]?.taskSessionId, "task-48");
  assert.equal(synchronized.pendingItems[0]?.taskSessionId, "task-49");
  assert.deepEqual(synchronized.recentChanges[0]?.files, ["src/file-48.ts"]);

  const afterHistoryDeletion = synchronizeProjectMemoryWithTasks(synchronized, []);
  assert.deepEqual(afterHistoryDeletion.recentChanges, synchronized.recentChanges);
  assert.deepEqual(afterHistoryDeletion.pendingItems, []);
});

test("重新扫描更新自动简介但保护手工简介", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const initial = await getProjectMemory({ workspaceRoot, sessions: [] });

  // 模拟第一版没有来源字段的自动摘要，验证升级后的兼容识别行为。
  const memoryPath = path.join(workspaceRoot, ".mini-ai", "state", "runtime", "project-memory.json");
  const { projectSummarySource: _source, ...legacyMemory } = initial;
  await fs.writeFile(memoryPath, JSON.stringify({ ...legacyMemory, schemaVersion: 1 }), "utf8");
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "memory-sample", dependencies: { vue: "^3.0.0" } }), "utf8");
  const refreshed = await refreshProjectMemoryAnalysis(workspaceRoot);
  assert.match(refreshed.projectSummary, /vue/);
  assert.equal(refreshed.projectSummarySource, "generated");

  await updateProjectMemory({ projectSummary: "手工项目简介" }, workspaceRoot);
  const manual = await refreshProjectMemoryAnalysis(workspaceRoot);
  assert.equal(manual.projectSummary, "手工项目简介");
  assert.equal(manual.projectSummarySource, "manual");
});
