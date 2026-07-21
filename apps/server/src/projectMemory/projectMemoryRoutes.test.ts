import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import test from "node:test";
import express from "express";
import { HttpError } from "../errors.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createProjectMemoryTestWorkspace } from "./fixtures/projectMemoryV2.fixture.js";
import { createProjectMemoryRouter } from "./routes.js";
import { recordMemoryRetrievalUsage } from "./memoryUsageService.js";

async function createTestServer(workspaceRoot: string) {
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const app = express();
  app.use(express.json());
  app.use("/api/project-memory", createProjectMemoryRouter());
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function requestJson(baseUrl: string, pathName: string, method = "GET", body?: unknown) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

test("候选记忆 HTTP API 完成创建、编辑、接受、拒绝和删除闭环", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const server = await createTestServer(workspaceRoot);
  context.after(() => server.close());

  const created = await requestJson(server.baseUrl, "/api/project-memory/candidates", "POST", {
    kind: "decision",
    content: "统一使用 pnpm",
    scope: { type: "project", paths: [] },
    sourceRefs: [{ type: "user", value: "message-1" }]
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.candidate.status, "candidate");
  assert.equal(created.data.candidate.createdBy, "user");
  const id = created.data.candidate.id as string;

  const duplicate = await requestJson(server.baseUrl, "/api/project-memory/candidates", "POST", {
    kind: "decision",
    content: "统一使用 pnpm。",
    sourceRefs: [{ type: "user", value: "message-2" }]
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.data.created, false);

  const edited = await requestJson(server.baseUrl, `/api/project-memory/candidates/${id}`, "PATCH", { content: "统一使用 pnpm workspace" });
  assert.equal(edited.response.status, 200);
  assert.equal(edited.data.candidate.content, "统一使用 pnpm workspace");

  const accepted = await requestJson(server.baseUrl, `/api/project-memory/candidates/${id}/accept`, "POST", {});
  assert.equal(accepted.data.candidate.status, "active");
  assert.equal((await requestJson(server.baseUrl, "/api/project-memory/candidates")).data.candidates.length, 0);

  const deleted = await requestJson(server.baseUrl, `/api/project-memory/items/${id}`, "DELETE");
  assert.equal(deleted.response.status, 204);

  const rejectCandidate = await requestJson(server.baseUrl, "/api/project-memory/candidates", "POST", { kind: "risk", content: "存在兼容风险" });
  const rejected = await requestJson(server.baseUrl, `/api/project-memory/candidates/${rejectCandidate.data.candidate.id}/reject`, "POST", {});
  assert.equal(rejected.response.status, 204);
  assert.equal((await requestJson(server.baseUrl, "/api/project-memory/candidates")).data.candidates.length, 0);
});

test("候选 API 拒绝 active 状态、系统来源、非法枚举和敏感信息", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const server = await createTestServer(workspaceRoot);
  context.after(() => server.close());

  const cases = [
    { kind: "fact", content: "普通事实", status: "active" },
    { kind: "fact", content: "普通事实", sourceRefs: [{ type: "task", value: "task-1" }] },
    { kind: "instruction", content: "普通事实" },
    { kind: "fact", content: "API_KEY=secret-value-123456" }
  ];
  for (const body of cases) {
    const result = await requestJson(server.baseUrl, "/api/project-memory/candidates", "POST", body);
    assert.equal(result.response.status, 400);
  }
  assert.equal((await requestJson(server.baseUrl, "/api/project-memory/candidates")).data.candidates.length, 0);
});

test("管理 API 支持条目查询、召回解释、规则提升和确认式批量清理", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const server = await createTestServer(workspaceRoot);
  context.after(() => server.close());

  const first = await requestJson(server.baseUrl, "/api/project-memory/candidates", "POST", { kind: "decision", content: "API 使用统一错误格式" });
  const second = await requestJson(server.baseUrl, "/api/project-memory/candidates", "POST", { kind: "fact", content: "测试使用 Node test" });
  const id = first.data.candidate.id as string;
  await requestJson(server.baseUrl, `/api/project-memory/candidates/${id}/accept`, "POST", {});
  const items = await requestJson(server.baseUrl, "/api/project-memory/items");
  assert.ok(items.data.items.some((item: { id: string }) => item.id === id));

  await recordMemoryRetrievalUsage({
    workspaceRoot,
    context: { userRequest: "调整 API 错误", contextPaths: [], plannedFiles: [], languages: [], frameworks: [], maxItems: 8, tokenBudget: 1_200 },
    rankedItems: [{ item: { ...first.data.candidate, status: "active" }, score: 42, reasons: ["request:api"] }],
    consideredItemIds: new Set([id]),
    includedItemIds: new Set([id]),
    estimatedTokens: 120
  });
  const usage = await requestJson(server.baseUrl, "/api/project-memory/usage");
  assert.equal(usage.data.records[0].entries[0].includedInPrompt, true);

  const unconfirmedPromotion = await requestJson(server.baseUrl, `/api/project-memory/items/${id}/promote`, "POST", {
    ruleFile: "api-errors.md", scope: "project", paths: [], alwaysApply: true, confirmed: false
  });
  assert.equal(unconfirmedPromotion.response.status, 400);
  const promoted = await requestJson(server.baseUrl, `/api/project-memory/items/${id}/promote`, "POST", {
    ruleFile: "api-errors.md", scope: "project", paths: [], alwaysApply: true, confirmed: true
  });
  assert.equal(promoted.response.status, 201);
  assert.equal(promoted.data.item.promotedTo.rulePath, ".mini-ai/rules/api-errors.md");

  const unconfirmedDelete = await requestJson(server.baseUrl, "/api/project-memory/items/bulk-delete", "POST", { ids: [second.data.candidate.id], confirmed: false });
  assert.equal(unconfirmedDelete.response.status, 400);
  const deleted = await requestJson(server.baseUrl, "/api/project-memory/items/bulk-delete", "POST", { ids: [second.data.candidate.id], confirmed: true });
  assert.equal(deleted.data.deletedCount, 1);
});
