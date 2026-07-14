import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import { runAgentRuntime } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { TaskSession } from "../types.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { buildProjectMemoryPrompt } from "./projectMemoryPrompt.js";
import { readProjectMemory } from "./projectMemoryStore.js";
import { getProjectMemory, refreshProjectMemoryAnalysis, synchronizeProjectMemoryWithTasks, updateProjectMemory } from "./projectMemoryService.js";
import { createProjectMemoryRouter } from "./routes.js";
import { config } from "../config.js";
import { generateTaskPlan } from "../taskPlanService.js";
import { generateAiEdit } from "../aiClient.js";

async function createWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-project-memory-"));
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ name: "memory-sample", packageManager: "pnpm@9", dependencies: { react: "^18.0.0" } }),
    "utf8"
  );
  await fs.writeFile(path.join(workspaceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return workspaceRoot;
}

function createTask(overrides: Partial<TaskSession>): TaskSession {
  const now = Date.now();
  return {
    id: "task-default",
    userGoal: "完成默认任务",
    status: "success",
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    steps: [],
    checkpointIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

test("首次读取会扫描项目并持久化 Project Memory", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const memory = await getProjectMemory({ workspaceRoot, sessions: [] });
  const persisted = await readProjectMemory(workspaceRoot);

  assert.equal(memory.techStack.packageManager, "pnpm");
  assert.ok(memory.techStack.frameworks.includes("react"));
  assert.match(memory.projectSummary, /pnpm/);
  assert.deepEqual(persisted, memory);
  assert.equal(memory.projectSummarySource, "generated");
});

test("局部更新保留自动字段并对重复约定去重", async (context) => {
  const workspaceRoot = await createWorkspace();
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
  const workspaceRoot = await createWorkspace();
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

test("任务历史会汇总最近改动和未完成事项并限制数量", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const base = await getProjectMemory({ workspaceRoot, sessions: [], syncTasks: false });
  const sessions = Array.from({ length: 50 }, (_, index) =>
    createTask({
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

test("提示词包含长期约定并保持上下文长度上限", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const memory = await getProjectMemory({ workspaceRoot, sessions: [], syncTasks: false });
  memory.conventions = Array.from({ length: 30 }, (_, index) => `约定 ${index} ${"x".repeat(500)}`);
  memory.confirmedRisks = ["不要修改生成目录"];

  const prompt = buildProjectMemoryPrompt(memory);

  assert.match(prompt, /Project Memory/);
  assert.match(prompt, /不要修改生成目录/);
  assert.match(prompt, /current user request/i);
  assert.match(prompt, /not instructions/i);
  assert.ok(prompt.length <= 6_000);

  const trusted = prompt.split("\n").find((line) => line.startsWith("trustedConventions="));
  const contextData = prompt.split("\n").find((line) => line.startsWith("contextData="));
  assert.doesNotThrow(() => JSON.parse(trusted?.slice("trustedConventions=".length) || ""));
  assert.doesNotThrow(() => JSON.parse(contextData?.slice("contextData=".length) || ""));
});

test("重新扫描更新自动简介但保留手工简介", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const initial = await getProjectMemory({ workspaceRoot, sessions: [] });

  // 模拟第一版没有 projectSummarySource 的自动摘要，验证升级后仍可识别并刷新。
  const memoryPath = path.join(workspaceRoot, ".mini-ai", "state", "runtime", "project-memory.json");
  const { projectSummarySource: _source, ...legacyMemory } = initial;
  await fs.writeFile(memoryPath, JSON.stringify({ ...legacyMemory, schemaVersion: 1 }), "utf8");
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "memory-sample", dependencies: { vue: "^3.0.0" } }), "utf8");
  const refreshed = await refreshProjectMemoryAnalysis(workspaceRoot);
  assert.equal(initial.projectSummarySource, "generated");
  assert.match(refreshed.projectSummary, /vue/);
  assert.equal(refreshed.projectSummarySource, "generated");

  await updateProjectMemory({ projectSummary: "手工项目简介" }, workspaceRoot);
  const manual = await refreshProjectMemoryAnalysis(workspaceRoot);
  assert.equal(manual.projectSummary, "手工项目简介");
  assert.equal(manual.projectSummarySource, "manual");
});

test("Agent Runtime 默认从磁盘加载 Project Memory", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  await getProjectMemory({ workspaceRoot, sessions: [] });
  await updateProjectMemory({ conventions: ["MEMORY_FROM_DISK_SENTINEL"] }, workspaceRoot);
  let systemPrompt = "";

  await runAgentRuntime({
    userRequest: "检查记忆",
    registry: createAgentToolRegistry([]),
    requestCompletion: async (body) => {
      systemPrompt = ((body.messages as Array<{ content?: string }>)[0]?.content || "");
      return { choices: [{ message: { role: "assistant", content: "完成" } }] };
    }
  });

  assert.match(systemPrompt, /MEMORY_FROM_DISK_SENTINEL/);
});

test("任务计划和直接编辑默认注入磁盘 Project Memory", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");
  await getProjectMemory({ workspaceRoot, sessions: [] });
  await updateProjectMemory({ conventions: ["ALL_AI_PATHS_SENTINEL"] }, workspaceRoot);
  const originalApiKey = config.aiApiKey;
  const originalFetch = globalThis.fetch;
  const systemPrompts: string[] = [];
  config.aiApiKey = "test-key";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body || "{}")) as { messages?: Array<{ content?: string }> };
    systemPrompts.push(body.messages?.[0]?.content || "");
    const isTaskPlan = systemPrompts.length === 1;
    const content = isTaskPlan
      ? JSON.stringify({ items: [{ title: "分析并实现", status: "pending" }] })
      : JSON.stringify({
          status: "patch",
          summary: "更新值",
          patches: [{ filePath: "src/app.ts", oldContent: "export const value = 1;\n", newContent: "export const value = 2;\n", summary: "更新值" }]
        });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  context.after(() => {
    config.aiApiKey = originalApiKey;
    globalThis.fetch = originalFetch;
  });

  await generateTaskPlan("实现功能");
  await generateAiEdit("src/app.ts", "export const value = 1;\n", "更新值");

  assert.equal(systemPrompts.length, 2);
  assert.ok(systemPrompts.every((prompt) => prompt.includes("ALL_AI_PATHS_SENTINEL")));
});

test("Project Memory HTTP API 支持读取、更新、刷新和参数校验", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const app = express();
  app.use(express.json());
  app.use("/api/project-memory", createProjectMemoryRouter());
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const typed = error as { status?: number; message?: string };
    response.status(typed.status || 500).json({ error: typed.message || "error" });
  });
  const server = app.listen(0);
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/api/project-memory`;

  const initial = await fetch(baseUrl);
  assert.equal(initial.status, 200);
  const updated = await fetch(baseUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conventions: ["使用 pnpm"], currentGoals: ["完成 Project Memory"] })
  });
  const updatedBody = await updated.json() as { memory: { conventions: string[]; currentGoals: string[]; projectSummarySource: string } };
  assert.deepEqual(updatedBody.memory.conventions, ["使用 pnpm"]);
  assert.deepEqual(updatedBody.memory.currentGoals, ["完成 Project Memory"]);
  assert.equal(updatedBody.memory.projectSummarySource, "generated");

  const invalid = await fetch(baseUrl, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ conventions: "invalid" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${baseUrl}/refresh`, { method: "POST" })).status, 200);
});

test("损坏的 Project Memory 返回明确错误且不会覆盖原文件", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const memoryPath = path.join(workspaceRoot, ".mini-ai", "state", "runtime", "project-memory.json");
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, "{invalid", "utf8");

  await assert.rejects(() => getProjectMemory({ workspaceRoot, sessions: [] }), /invalid JSON/);
  assert.equal(await fs.readFile(memoryPath, "utf8"), "{invalid");
});
