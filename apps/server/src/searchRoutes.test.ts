import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import { createSearchRouter } from "./searchRoutes.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

async function createTestServer(workspaceRoot: string) {
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const app = express();
  app.use("/api", createSearchRouter());
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Internal server error";
    response.status(status).json({ error: message });
  });

  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Failed to start test server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

async function fetchJson(baseUrl: string, pathName: string) {
  const response = await fetch(`${baseUrl}${pathName}`);
  const data = await response.json();
  return { response, data };
}

test("search routes expose file name, literal, regex, and invalid-regex responses", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-search-routes-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "CodeSearchPanel.tsx"), ["before", "export function searchFilesByName() {}", "export const searchCode = true;", "after"].join("\n"), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "notes.md"), "searchFilesByName\n", "utf8");

    const server = await createTestServer(workspaceRoot);

    try {
      const fileName = await fetchJson(server.baseUrl, "/api/search/files?q=CodeSearchPanel&path=src&limit=5");
      assert.equal(fileName.response.status, 200);
      assert.equal(fileName.data.results[0].path, "src/CodeSearchPanel.tsx");

      const literal = await fetchJson(server.baseUrl, "/api/search?q=searchFilesByName&mode=literal&path=src&filePattern=*.tsx&limit=5&contextLines=1");
      assert.equal(literal.response.status, 200);
      assert.equal(literal.data.results.length, 1);
      assert.equal(literal.data.results[0].filePath, "src/CodeSearchPanel.tsx");
      assert.deepEqual(literal.data.results[0].contextBefore, [{ line: 1, content: "before" }]);

      const regex = await fetchJson(server.baseUrl, "/api/search?q=search(Code|FilesByName)&mode=regex&path=src&filePattern=*.tsx&limit=5");
      assert.equal(regex.response.status, 200);
      assert.equal(regex.data.results.length, 2);

      const invalidRegex = await fetchJson(server.baseUrl, "/api/search?q=(&mode=regex&path=src");
      assert.equal(invalidRegex.response.status, 400);
      assert.match(invalidRegex.data.error, /Invalid regular expression|Unterminated group/);
    } finally {
      await server.close();
    }
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
