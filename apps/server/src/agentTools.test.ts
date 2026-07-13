import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentToolRuntime, executeAgentToolCall, type AgentContext, type AgentToolCall } from "./agentTools.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

function createToolCall(name: string, args: Record<string, unknown>): AgentToolCall {
  return {
    id: `call-${name}`,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args)
    }
  };
}

function createAgentContext(): AgentContext {
  return {
    userGoal: "读取文件范围",
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: []
  };
}

test("readFileRange reads an inclusive 1-based line range with boundary metadata", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"), "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("readFileRange", { filePath: "sample.txt", startLine: 2, endLine: 4 }),
    createAgentToolRuntime({ agentContext, runId: "test-read-range" })
  );
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.content, "line 2\nline 3\nline 4");
  assert.equal(data.startLine, 2);
  assert.equal(data.endLine, 4);
  assert.equal(data.linesRead, 3);
  assert.equal(data.totalLines, 5);
  assert.equal(data.hasMoreBefore, true);
  assert.equal(data.hasMoreAfter, true);
  assert.equal(data.truncated, false);
  assert.deepEqual(agentContext.filesRead, ["sample.txt"]);
  assert.deepEqual(agentContext.relevantFiles, ["sample.txt"]);
});

test("readFileRange caps very large line ranges", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  const content = Array.from({ length: 300 }, (_item, index) => `line ${index + 1}`).join("\n");
  await fs.writeFile(path.join(workspaceRoot, "large.txt"), content, "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("readFileRange", { filePath: "large.txt", startLine: 10, endLine: 300 }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-read-range-cap" })
  );
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.startLine, 10);
  assert.equal(data.endLine, 249);
  assert.equal(data.linesRead, 240);
  assert.equal(data.totalLines, 300);
  assert.equal(data.hasMoreAfter, true);
  assert.equal(data.truncated, true);
});

test("readFile returns the first chunk instead of the entire long file", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  const content = Array.from({ length: 205 }, (_item, index) => `line ${index + 1}`).join("\n");
  await fs.writeFile(path.join(workspaceRoot, "large.txt"), content, "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("readFile", { filePath: "large.txt" }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-read-file-first-chunk" })
  );
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.startLine, 1);
  assert.equal(data.endLine, 200);
  assert.equal(data.linesRead, 200);
  assert.equal(data.totalLines, 205);
  assert.equal(data.hasMoreAfter, true);
  assert.equal(data.nextStartLine, 201);
  assert.equal((data.content as string).split("\n").at(-1), "line 200");
});

test("readFileChunk reads follow-up chunks with continuation metadata", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  const content = Array.from({ length: 5 }, (_item, index) => `line ${index + 1}`).join("\n");
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), content, "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("readFileChunk", { filePath: "sample.txt", startLine: 3, endLine: 5 }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-read-file-chunk" })
  );
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.content, "line 3\nline 4\nline 5");
  assert.equal(data.startLine, 3);
  assert.equal(data.endLine, 5);
  assert.equal(data.hasMoreBefore, true);
  assert.equal(data.hasMoreAfter, false);
});

test("searchFilesByName finds workspace paths without reading files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "views"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "views", "SettingsPage.tsx"), "settings\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("searchFilesByName", { query: "SettingsPage" }),
    createAgentToolRuntime({ agentContext, runId: "test-search-files-by-name" })
  );
  const data = JSON.parse(response.content) as Array<Record<string, unknown>>;

  assert.equal(data[0].path, "src/views/SettingsPage.tsx");
  assert.equal(data[0].matchedBy, "name");
  assert.deepEqual(agentContext.filesRead, []);
  assert.deepEqual(agentContext.searchResultFiles, ["src/views/SettingsPage.tsx"]);
});

test("findSimilarPatterns returns reusable candidates and records them as relevant files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "userService.ts"), "export async function getUser() { return true; }\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("findSimilarPatterns", {
      taskDescription: "新增订单服务",
      targetPath: "src/services/orderService.ts",
      targetResponsibility: "service"
    }),
    createAgentToolRuntime({ agentContext, runId: "test-find-similar-patterns" })
  );
  const data = JSON.parse(response.content) as { candidates: Array<{ filePath: string }> };

  assert.equal(data.candidates[0]?.filePath, "src/services/userService.ts");
  assert.deepEqual(agentContext.searchResultFiles, ["src/services/userService.ts"]);
  assert.deepEqual(agentContext.relevantFiles, ["src/services/userService.ts"]);
});

test("checkExistence records unresolved references for the runtime edit gate", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("checkExistence", {
      targets: [{ kind: "script", value: "test" }, { kind: "import", value: "./missing", fromPath: "src/app.ts" }]
    }),
    createAgentToolRuntime({ agentContext, runId: "test-check-existence" })
  );
  const data = JSON.parse(response.content) as { summary: { exists: number; missing: number } };

  assert.deepEqual(data.summary, { exists: 1, missing: 1, ambiguous: 0 });
  assert.equal(agentContext.existenceCheckPerformed, true);
  assert.deepEqual(agentContext.unresolvedExistenceChecks, ["import:./missing"]);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test("findSimilarPatterns does not reuse stale cached candidates", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "userService.ts"), "export async function getUser() { return true; }\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-find-similar-patterns-cache" });
  const call = createToolCall("findSimilarPatterns", { taskDescription: "新增订单服务", targetPath: "src/services/orderService.ts", targetResponsibility: "service" });

  await executeAgentToolCall(call, runtime);
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "orderService.ts"), "export async function orderService() { return true; }\n", "utf8");
  const response = await executeAgentToolCall(call, runtime);
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.cached, undefined);
});

test("searchCodeRegex searches code patterns and records relevant files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "api.ts"), ["export function getUserList() {}", "export function updateUser() {}"].join("\n"), "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "notes.md"), "getUserList\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("searchCodeRegex", { regex: "get(User|Order)List", path: "src", filePattern: "*.ts" }),
    createAgentToolRuntime({ agentContext, runId: "test-search-code-regex" })
  );
  const data = JSON.parse(response.content) as Array<Record<string, unknown>>;

  assert.equal(data.length, 1);
  assert.equal(data[0].filePath, "src/api.ts");
  assert.equal(data[0].line, 1);
  assert.equal(data[0].match, "getUserList");
  assert.deepEqual(agentContext.searchQueries, ["regex:get(User|Order)List"]);
  assert.deepEqual(agentContext.searchResultFiles, ["src/api.ts"]);
  assert.deepEqual(agentContext.relevantFiles, ["src/api.ts"]);
});

test("searchCode accepts filePattern filters while preserving literal search behavior", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "api.ts"), "literalMarker\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "api.md"), "literalMarker\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("searchCode", { query: "literalMarker", path: "src", filePattern: "*.ts" }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-search-code-options" })
  );
  const data = JSON.parse(response.content) as Array<Record<string, unknown>>;

  assert.deepEqual(
    data.map((entry) => entry.filePath),
    ["src/api.ts"]
  );
});

test("listFiles lists only the requested directory level by default", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "nested"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "entry.ts"), "entry\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "nested", "child.ts"), "child\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("listFiles", { path: "src" }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-list-files" })
  );
  const data = JSON.parse(response.content) as Array<Record<string, unknown>>;

  assert.deepEqual(
    data.map((entry) => entry.path),
    ["src/nested", "src/entry.ts"]
  );
});

test("listCodeDefinitionNames exposes structure summaries without reading full files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(
    path.join(workspaceRoot, "src", "feature.ts"),
    ["export class FeatureService {}", "export function createFeature() {}", "const localState = true;"].join("\n"),
    "utf8"
  );
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("listCodeDefinitionNames", { path: "src" }),
    createAgentToolRuntime({ agentContext, runId: "test-list-code-definition-names" })
  );
  const data = JSON.parse(response.content) as Array<Record<string, unknown>>;
  const definitions = data[0].definitions as Array<Record<string, unknown>>;

  assert.equal(data[0].filePath, "src/feature.ts");
  assert.deepEqual(
    definitions.map((definition) => [definition.name, definition.kind, definition.line]),
    [
      ["FeatureService", "class", 1],
      ["createFeature", "function", 2],
      ["localState", "variable", 3]
    ]
  );
  assert.deepEqual(agentContext.filesRead, []);
  assert.deepEqual(agentContext.searchResultFiles, ["src/feature.ts"]);
});

test("analyzeSymbolGraph returns symbol references and records related files", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "service.ts"), "export function loadUser() { return true }\n", "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, "src", "controller.ts"),
    "import { loadUser } from './service.js'\nexport function getUser() { return loadUser() }\n",
    "utf8"
  );
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("analyzeSymbolGraph", { kind: "references", symbolName: "loadUser" }),
    createAgentToolRuntime({ agentContext, runId: "test-symbol-graph" })
  );
  const data = JSON.parse(response.content) as { references: Array<{ filePath: string; kind: string }>; indexedSymbolCount: number; indexTruncated: boolean };

  assert.equal(data.indexedSymbolCount >= 2, true);
  assert.equal(data.indexTruncated, false);
  assert.equal(data.references.some((reference) => reference.filePath === "src/controller.ts" && reference.kind === "call"), true);
  assert.deepEqual(agentContext.searchResultFiles.sort(), ["src/controller.ts", "src/service.ts"]);
  assert.equal(agentContext.searchQueries[0], "symbol:references:loadUser");
});

test("analyzeImpact returns upstream consumers and records the impact scope", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "service.ts"), "export function loadUser() { return true }\n", "utf8");
  await fs.writeFile(
    path.join(workspaceRoot, "src", "routes", "userRoute.ts"),
    "import { loadUser } from '../service.js'\nexport function getUser() { return loadUser() }\n",
    "utf8"
  );
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const agentContext = createAgentContext();
  const response = await executeAgentToolCall(
    createToolCall("analyzeImpact", { changes: [{ filePath: "src/service.ts", symbolName: "loadUser", changeKind: "signature" }] }),
    createAgentToolRuntime({ agentContext, runId: "test-impact-analyzer" })
  );
  const data = JSON.parse(response.content) as {
    impactedFiles: Array<{ filePath: string }>;
    boundaryFiles: string[];
    risk: { level: string };
  };

  assert.deepEqual(data.impactedFiles.map((file) => file.filePath), ["src/routes/userRoute.ts"]);
  assert.deepEqual(data.boundaryFiles, ["src/routes/userRoute.ts"]);
  assert.equal(data.risk.level, "high");
  assert.deepEqual(agentContext.searchResultFiles, ["src/routes/userRoute.ts"]);
  assert.deepEqual(agentContext.relevantFiles.sort(), ["src/routes/userRoute.ts", "src/service.ts"]);
  assert.equal(agentContext.searchQueries[0], "impact:src/service.ts#loadUser");
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test("analyzeImpact tool enforces maxFiles and exposes truncation metadata", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "service.ts"), "export function loadUser() { return true }\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "consumerA.ts"), "import { loadUser } from './service.js'\nloadUser()\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "consumerB.ts"), "import { loadUser } from './service.js'\nloadUser()\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const response = await executeAgentToolCall(
    createToolCall("analyzeImpact", { changes: [{ filePath: "src/service.ts", symbolName: "loadUser" }], maxFiles: 1 }),
    createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-impact-analyzer-limit" })
  );
  const data = JSON.parse(response.content) as { impactedFiles: unknown[]; truncated: boolean; diagnostics: string[] };

  assert.equal(data.impactedFiles.length, 1);
  assert.equal(data.truncated, true);
  assert.match(data.diagnostics.at(-1) || "", /结果已截断/);
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

test("read tools emit activity steps without an approval card", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "hello\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const steps: Array<{ type: string; actionType?: string; status?: string; toolName?: string }> = [];
  await executeAgentToolCall(
    createToolCall("readFile", { filePath: "sample.txt" }),
    createAgentToolRuntime({
      agentContext: createAgentContext(),
      runId: "test-read-approval",
      onAgentStep(step) {
        steps.push(step);
      }
    })
  );

  // 只读工具是低风险上下文活动，不再渲染成审批卡，避免和人工审批混淆。
  assert.equal(steps.some((step) => step.type === "approval_request"), false);
  assert.equal(steps[0].type, "tool_call");
  assert.equal(steps[0].toolName, "readFile");
});

test("readFileChunk returns an explicit cached marker for duplicate calls", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "hello\nworld\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-cache-hit" });

  const firstResponse = await executeAgentToolCall(createToolCall("readFileChunk", { filePath: "sample.txt", startLine: 1, endLine: 1 }), runtime);
  const secondResponse = await executeAgentToolCall(createToolCall("readFileChunk", { filePath: "sample.txt", startLine: 1, endLine: 1 }), runtime);
  const firstData = JSON.parse(firstResponse.content) as Record<string, unknown>;
  const secondData = JSON.parse(secondResponse.content) as Record<string, unknown>;

  assert.equal(firstData.cached, undefined);
  assert.equal(secondData.cached, true);
  assert.equal(secondData.content, "hello");
  assert.match(String(secondData.note), /already called/);
});

test("readFileChunk cache is invalidated after the target file changes", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "old value\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-cache-stale" });

  await executeAgentToolCall(createToolCall("readFileChunk", { filePath: "sample.txt", startLine: 1, endLine: 1 }), runtime);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "new value\n", "utf8");

  const response = await executeAgentToolCall(createToolCall("readFileChunk", { filePath: "sample.txt", startLine: 1, endLine: 1 }), runtime);
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.equal(data.cached, undefined);
  assert.equal(data.content, "new value");
});

test("cache does not bypass workspace boundary validation", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.txt"), "safe\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-cache-boundary" });

  await executeAgentToolCall(createToolCall("readFile", { filePath: "sample.txt" }), runtime);

  const response = await executeAgentToolCall(createToolCall("readFile", { filePath: "../sample.txt" }), runtime);
  const data = JSON.parse(response.content) as Record<string, unknown>;

  assert.match(String(data.error), /outside workspace/i);
});

test("case-sensitive searchCode cache keeps differently cased queries separate", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.writeFile(path.join(workspaceRoot, "sample.ts"), "Foo\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-cache-case-sensitive" });

  const firstResponse = await executeAgentToolCall(createToolCall("searchCode", { query: "Foo", caseSensitive: true }), runtime);
  const secondResponse = await executeAgentToolCall(createToolCall("searchCode", { query: "foo", caseSensitive: true }), runtime);
  const firstData = JSON.parse(firstResponse.content) as Array<Record<string, unknown>>;
  const secondData = JSON.parse(secondResponse.content) as Array<Record<string, unknown>>;

  assert.equal(firstData.length, 1);
  assert.equal(secondData.length, 0);
});

test("empty searchCode cache is invalidated when the searched directory changes", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-empty-search-cache-stale" });

  const firstResponse = await executeAgentToolCall(createToolCall("searchCode", { query: "newMarker", path: "src" }), runtime);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await fs.writeFile(path.join(workspaceRoot, "src", "feature.ts"), "export const newMarker = true;\n", "utf8");
  const secondResponse = await executeAgentToolCall(createToolCall("searchCode", { query: "newMarker", path: "src" }), runtime);
  const firstData = JSON.parse(firstResponse.content) as Array<Record<string, unknown>>;
  const secondData = JSON.parse(secondResponse.content) as Array<Record<string, unknown>>;

  assert.equal(firstData.length, 0);
  assert.equal(secondData.length, 1);
  assert.equal(secondData[0].cached, undefined);
  assert.equal(secondData[0].filePath, "src/feature.ts");
});

test("listFiles cache is invalidated when a listed directory changes", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-tools-"));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "a.ts"), "a\n", "utf8");
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const runtime = createAgentToolRuntime({ agentContext: createAgentContext(), runId: "test-list-files-cache-stale" });

  await executeAgentToolCall(createToolCall("listFiles", { path: "src" }), runtime);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await fs.writeFile(path.join(workspaceRoot, "src", "b.ts"), "b\n", "utf8");

  const response = await executeAgentToolCall(createToolCall("listFiles", { path: "src" }), runtime);
  const data = JSON.parse(response.content) as Array<Record<string, unknown>>;

  assert.deepEqual(
    data.map((entry) => entry.path),
    ["src/a.ts", "src/b.ts"]
  );
});
