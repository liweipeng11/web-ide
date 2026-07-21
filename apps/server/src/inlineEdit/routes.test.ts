import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";
import { config } from "../config.js";
import type { InlineEditRequest } from "../contracts/inlineEdit.js";
import { createInlineEditRouter } from "./routes.js";
import type { InlineEditGenerator } from "./inlineEditService.js";

const originalModelProviderGateway = config.featureFlags.modelProviderGateway;

test.before(() => {
  // 路由行为测试使用注入的 Mock Generator，不应依赖用户磁盘中的模型选择配置。
  config.featureFlags.modelProviderGateway = false;
});

test.after(() => {
  config.featureFlags.modelProviderGateway = originalModelProviderGateway;
});

const request: InlineEditRequest = {
  filePath: "src/example.ts",
  documentVersion: 3,
  documentLineCount: 1,
  selectionStartLineMaxColumn: 12,
  selectionEndLineMaxColumn: 12,
  selection: { start: { line: 1, column: 1 }, end: { line: 1, column: 12 } },
  selectedText: "const a = 1",
  instruction: "重命名变量",
  prefix: "",
  suffix: "",
  languageId: "typescript"
};

async function startRouter(generator: InlineEditGenerator) {
  const app = express();
  app.use(express.json());
  app.use("/api", createInlineEditRouter({ generator }));
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务启动失败");
  return { server, url: `http://127.0.0.1:${address.port}/api/inline-edit/stream` };
}

test("Inline Edit SSE 返回流式候选和最终结构化结果", async () => {
  const { server, url } = await startRouter(async (_prompt, onDelta) => {
    const content = JSON.stringify({ mode: "inline", filePath: request.filePath, baseVersion: 3, range: request.selection, replacement: "const count = 1" });
    onDelta(content.slice(0, content.indexOf("count")));
    onDelta(content.slice(content.indexOf("count")));
    return content;
  });
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: candidate_delta/);
    assert.match(body, /const count = 1/);
    assert.match(body, /event: result/);
  } finally {
    server.close();
  }
});

test("客户端取消 SSE 后中止模型生成", async () => {
  let aborted = false;
  const { server, url } = await startRouter((_prompt, _onDelta, signal) => new Promise<string>((_resolve, reject) => {
    signal?.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("cancelled"));
    }, { once: true });
  }));
  const controller = new AbortController();
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: controller.signal });
    await response.body?.getReader().read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(aborted, true);
  } finally {
    server.close();
  }
});
