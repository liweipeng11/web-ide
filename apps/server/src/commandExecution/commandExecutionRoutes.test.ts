import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { HttpError } from "../errors.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createCommandExecutionRouter } from "./commandExecutionRoutes.js";
import { CommandExecutionService } from "./commandExecutionService.js";
import type { CommandProcessFactory } from "./commandProcess.js";

function createService() {
  let sequence = 0;
  const processFactory: CommandProcessFactory = {
    start(options, listeners) {
      queueMicrotask(() => {
        if (options.command.includes("serve")) listeners.onData("stdout", "ready at http://localhost:4173\n");
        else {
          listeners.onData("stdout", "123\n");
          listeners.onExit(0);
        }
      });
      return { pid: 1234, kill: () => true };
    }
  };
  return new CommandExecutionService({ processFactory, createId: () => `cmd-route-${++sequence}` });
}

async function createTestServer(workspaceRoot: string) {
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const app = express();
  app.use(express.json());
  app.use("/api", createCommandExecutionRouter({ service: createService() }));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(error instanceof HttpError ? error.status : 500).json({ error: error instanceof Error ? error.message : "Internal server error" });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function requestJson(baseUrl: string, pathname: string, method = "GET", body?: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, data: await response.json() as any };
}

test("execution HTTP API 支持启动、查询、列表、cursor 输出和后台控制", async (context) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "command-routes-"));
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "node test.js", serve: "node server.js" } }), "utf8");
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const server = await createTestServer(workspaceRoot);
  context.after(() => server.close());

  const started = await requestJson(server.baseUrl, "/api/command-executions", "POST", { command: "npm run test", taskSessionId: "task-1", chatId: "chat-1" });
  assert.equal(started.response.status, 201);
  const id = started.data.execution.id as string;
  await new Promise((resolve) => setImmediate(resolve));
  const fetched = await requestJson(server.baseUrl, `/api/command-executions/${id}`);
  assert.equal(fetched.data.execution.state, "succeeded");
  assert.equal(fetched.data.execution.taskSessionId, "task-1");
  const output = await requestJson(server.baseUrl, `/api/command-executions/${id}/output?cursor=0`);
  assert.match(output.data.output.data, /123/);
  assert.equal(output.data.output.nextCursor, 4);
  const listed = await requestJson(server.baseUrl, "/api/command-executions?chatId=chat-1");
  assert.equal(listed.data.executions.length, 1);

  const background = await requestJson(server.baseUrl, "/api/command-executions", "POST", { command: "npm run serve", mode: "background" });
  await new Promise((resolve) => setImmediate(resolve));
  const backgroundId = background.data.execution.id as string;
  const moved = await requestJson(server.baseUrl, `/api/command-executions/${backgroundId}/background`, "POST", {});
  assert.equal(moved.data.execution.mode, "background");
  const stopped = await requestJson(server.baseUrl, `/api/command-executions/${backgroundId}/stop`, "POST", {});
  assert.equal(stopped.data.execution.state, "cancelled");
});

test("execution HTTP API 保留策略、确认、cwd 和 package script 校验", async (context) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "command-routes-policy-"));
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const server = await createTestServer(workspaceRoot);
  context.after(() => server.close());

  assert.equal((await requestJson(server.baseUrl, "/api/command-executions", "POST", { command: "node -e \"console.log(1)\"" })).response.status, 409);
  assert.equal((await requestJson(server.baseUrl, "/api/command-executions", "POST", { command: "rm -rf build", confirmed: true })).response.status, 403);
  assert.equal((await requestJson(server.baseUrl, "/api/command-executions", "POST", { command: "node -e \"console.log(1)\"", cwd: "..", confirmed: true })).response.status, 400);
  assert.equal((await requestJson(server.baseUrl, "/api/command-executions", "POST", { command: "npm run test" })).response.status, 400);
});
