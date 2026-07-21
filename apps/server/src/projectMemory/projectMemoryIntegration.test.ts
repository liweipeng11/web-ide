import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import express, { type NextFunction, type Request, type Response } from "express";
import type { AddressInfo } from "node:net";
import { generateAiEdit } from "../aiClient.js";
import { runAgentRuntime } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import { config } from "../config.js";
import { generateTaskPlan } from "../taskPlanService.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createProjectMemoryTestWorkspace } from "./fixtures/projectMemoryV2.fixture.js";
import { getProjectMemory, updateProjectMemory } from "./projectMemoryService.js";
import { createProjectMemoryRouter } from "./routes.js";

test("Agent Runtime 默认从磁盘加载 Project Memory", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
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
  const workspaceRoot = await createProjectMemoryTestWorkspace();
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
    const content = systemPrompts.length === 1
      ? JSON.stringify({ items: [{ title: "分析并实现", status: "pending" }] })
      : JSON.stringify({
          status: "patch",
          summary: "更新值",
          patches: [{ filePath: "src/app.ts", oldContent: "export const value = 1;\n", newContent: "export const value = 2;\n", summary: "更新值" }]
        });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
  const workspaceRoot = await createProjectMemoryTestWorkspace();
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

  assert.equal((await fetch(baseUrl)).status, 200);
  const updated = await fetch(baseUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conventions: ["使用 pnpm"], currentGoals: ["完成 Project Memory"] })
  });
  const updatedBody = await updated.json() as { memory: { conventions: string[]; currentGoals: string[]; projectSummarySource: string } };
  assert.deepEqual(updatedBody.memory.conventions, ["使用 pnpm"]);
  assert.deepEqual(updatedBody.memory.currentGoals, ["完成 Project Memory"]);
  assert.equal(updatedBody.memory.projectSummarySource, "generated");

  const invalid = await fetch(baseUrl, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conventions: "invalid" })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await fetch(`${baseUrl}/refresh`, { method: "POST" })).status, 200);
});
