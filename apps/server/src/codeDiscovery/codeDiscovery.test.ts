import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../errors.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { listFiles, listWorkspaceFiles, readWorkspaceFileRange, safeResolve, searchWorkspaceCode, searchWorkspaceFilesByName } from "./index.js";

function flattenTreePaths(nodes: Awaited<ReturnType<typeof listFiles>>) {
  const paths: string[] = [];

  for (const node of nodes) {
    paths.push(node.path);

    if (node.type === "directory") {
      paths.push(...flattenTreePaths(node.children || []));
    }
  }

  return paths;
}

test("safeResolve rejects absolute paths and parent traversal outside workspace", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  try {
    assert.throws(() => safeResolve(path.join(workspaceRoot, "file.txt")), HttpError);
    assert.throws(() => safeResolve("../outside.txt"), HttpError);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("listFiles keeps ignored runtime state hidden unless explicitly allowed", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, ".mini-ai", "state"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".mini-ai", "AGENTS.md"), "# rules\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, ".mini-ai", "state", "runtime.json"), "{}\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const defaultPaths = flattenTreePaths(await listFiles(""));
    assert.ok(defaultPaths.includes(".mini-ai/AGENTS.md"));
    assert.ok(!defaultPaths.includes(".mini-ai/state"));

    const generatedPaths = flattenTreePaths(await listFiles("", true));
    assert.ok(generatedPaths.includes(".mini-ai/state/runtime.json"));
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("readWorkspaceFileRange returns bounded range metadata", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.writeFile(path.join(workspaceRoot, "sample.ts"), ["one", "two", "three"].join("\n"), "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const range = await readWorkspaceFileRange("sample.ts", 2, 10);
    assert.equal(range.content, "two\nthree");
    assert.equal(range.startLine, 2);
    assert.equal(range.endLine, 3);
    assert.equal(range.linesRead, 2);
    assert.equal(range.totalLines, 3);
    assert.equal(range.hasMoreBefore, true);
    assert.equal(range.hasMoreAfter, false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("searchWorkspaceCode keeps literal search result shape", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "feature.ts"), "export const phaseOneMarker = true;\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const results = await searchWorkspaceCode("phaseOneMarker");
    assert.equal(results.length, 1);
    assert.equal(results[0].filePath, "src/feature.ts");
    assert.equal(results[0].path, "src/feature.ts");
    assert.equal(results[0].line, 1);
    assert.equal(results[0].match, "phaseOneMarker");
    assert.match(results[0].content, /phaseOneMarker/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("listWorkspaceFiles can list one directory level without reading file contents", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "features"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "main.ts"), "main\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "features", "UserPanel.tsx"), "panel\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const entries = await listWorkspaceFiles("src", { recursive: false });
    assert.deepEqual(
      entries.map((entry) => entry.path),
      ["src/features", "src/main.ts"]
    );
    assert.equal(entries.find((entry) => entry.path === "src/features")?.type, "directory");
    assert.equal(entries.find((entry) => entry.path === "src/main.ts")?.type, "file");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("listWorkspaceFiles recursively skips ignored paths and rejects boundary traversal", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "visible.ts"), "visible\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "hidden.ts"), "hidden\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const entries = await listWorkspaceFiles("", { recursive: true });
    const paths = entries.map((entry) => entry.path);

    assert.ok(paths.includes("src/visible.ts"));
    assert.ok(!paths.includes("node_modules"));
    await assert.rejects(() => listWorkspaceFiles("../outside", { recursive: true }), HttpError);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("searchWorkspaceFilesByName matches names, extensions, and directory fragments", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "config"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "src", "views"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "config", "appConfig.ts"), "config\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "views", "UserPage.vue"), "page\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const nameMatches = await searchWorkspaceFilesByName("UserPage");
    assert.equal(nameMatches[0].path, "src/views/UserPage.vue");
    assert.equal(nameMatches[0].matchedBy, "name");

    const extensionMatches = await searchWorkspaceFilesByName(".vue");
    assert.equal(extensionMatches.some((entry) => entry.path === "src/views/UserPage.vue" && entry.matchedBy === "extension"), true);

    const pathMatches = await searchWorkspaceFilesByName("src/config");
    assert.equal(pathMatches.some((entry) => entry.path === "src/config/appConfig.ts"), true);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
