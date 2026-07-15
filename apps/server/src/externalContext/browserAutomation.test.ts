import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { automateBrowser, findBrowserExecutable, getBrowserAutomationCapability } from "./browserAutomation.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

test("浏览器能力检测找到本机 Chrome 或 Edge", async () => {
  const capability = await getBrowserAutomationCapability();
  assert.equal(capability.available, true);
  assert.ok(await findBrowserExecutable());
});

test("Playwright 执行 JavaScript 点击、等待选择器并保存截图", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "external-browser-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><head><title>Browser automation</title></head><body>
      <button id="load" onclick="setTimeout(() => { const node = document.createElement('p'); node.id = 'done'; node.textContent = '动态内容已加载'; document.body.appendChild(node); }, 25)">加载</button>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTP server did not expose a port");

  try {
    const result = await automateBrowser(
      {
        url: `http://127.0.0.1:${address.port}`,
        actions: [
          { type: "click", selector: "#load" },
          { type: "waitForSelector", selector: "#done", timeoutMs: 2_000 }
        ],
        screenshot: true
      },
      { validateUrl: async () => undefined }
    );

    assert.equal(result.renderedWith, "playwright");
    assert.equal(result.executedActions, 2);
    assert.match(result.content, /动态内容已加载/);
    assert.ok(result.screenshotPath);
    await fs.access(path.join(workspaceRoot, result.screenshotPath!));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
