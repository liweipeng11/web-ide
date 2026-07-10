import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "../errors.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { listCodeDefinitionNames, listFiles, listWorkspaceFiles, readWorkspaceFileChunk, readWorkspaceFileRange, safeResolve, searchTextRegex, searchWorkspaceCode, searchWorkspaceFilesByName } from "./index.js";

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

test("readWorkspaceFileChunk returns the default first chunk with continuation metadata", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    const content = Array.from({ length: 205 }, (_item, index) => `line ${index + 1}`).join("\n");
    await fs.writeFile(path.join(workspaceRoot, "large.ts"), content, "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const chunk = await readWorkspaceFileChunk("large.ts");

    assert.equal(chunk.startLine, 1);
    assert.equal(chunk.endLine, 200);
    assert.equal(chunk.linesRead, 200);
    assert.equal(chunk.totalLines, 205);
    assert.equal(chunk.hasMoreBefore, false);
    assert.equal(chunk.hasMoreAfter, true);
    assert.equal(chunk.nextStartLine, 201);
    assert.equal(chunk.content.split("\n").at(0), "line 1");
    assert.equal(chunk.content.split("\n").at(-1), "line 200");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("readWorkspaceFileChunk can continue without skipped or duplicated lines", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    const content = Array.from({ length: 6 }, (_item, index) => `line ${index + 1}`).join("\n");
    await fs.writeFile(path.join(workspaceRoot, "sample.ts"), content, "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const firstChunk = await readWorkspaceFileChunk("sample.ts", 1, 3);
    const secondChunk = await readWorkspaceFileChunk("sample.ts", firstChunk.nextStartLine, 6);

    assert.equal(firstChunk.content, "line 1\nline 2\nline 3");
    assert.equal(firstChunk.nextStartLine, 4);
    assert.equal(secondChunk.content, "line 4\nline 5\nline 6");
    assert.equal(secondChunk.hasMoreBefore, true);
    assert.equal(secondChunk.hasMoreAfter, false);
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

test("searchWorkspaceCode supports path, filePattern, limit, and case sensitivity options", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "feature.ts"), ["before", "SearchMarker", "after", "searchmarker"].join("\n"), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "feature.md"), "SearchMarker\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "docs", "feature.ts"), "SearchMarker\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const results = await searchWorkspaceCode("SearchMarker", {
      path: "src",
      filePattern: "*.ts",
      limit: 1,
      caseSensitive: true,
      contextLines: 1
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].filePath, "src/feature.ts");
    assert.equal(results[0].line, 2);
    assert.equal(results[0].match, "SearchMarker");
    assert.deepEqual(results[0].contextBefore, [{ line: 1, content: "before" }]);
    assert.deepEqual(results[0].contextAfter, [{ line: 3, content: "after" }]);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("searchTextRegex finds regex matches and reports invalid patterns clearly", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "service.ts"), ["export function loadUsers() {}", "export const loadOrders = () => {};"].join("\n"), "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const results = await searchTextRegex("load(Users|Orders)", { path: "src", filePattern: "*.ts", limit: 10 });

    assert.deepEqual(
      results.map((result) => [result.filePath, result.line, result.match]),
      [
        ["src/service.ts", 1, "loadUsers"],
        ["src/service.ts", 2, "loadOrders"]
      ]
    );
    assert.throws(() => searchTextRegex("("), HttpError);
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

test("listCodeDefinitionNames extracts top-level TypeScript and React definitions", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "definitions.tsx"),
      [
        "export interface UserCardProps {",
        "  name: string;",
        "}",
        "export type UserRole = 'admin' | 'user';",
        "export class UserService {}",
        "export function loadUsers() {",
        "  const localOnly = true;",
        "  return localOnly;",
        "}",
        "export const UserCard = () => null;",
        "const internalFlag = true;"
      ].join("\n"),
      "utf8"
    );
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const results = await listCodeDefinitionNames("src");
    const summary = results.find((item) => item.filePath === "src/definitions.tsx");

    assert.ok(summary);
    assert.equal(summary.language, "typescript");
    assert.deepEqual(
      summary.definitions.map((definition) => [definition.name, definition.kind, definition.line]),
      [
        ["UserCardProps", "interface", 1],
        ["UserRole", "type", 4],
        ["UserService", "class", 5],
        ["loadUsers", "function", 6],
        ["UserCard", "function", 10],
        ["internalFlag", "variable", 11]
      ]
    );
    assert.equal(summary.definitions.some((definition) => definition.name === "localOnly"), false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("listCodeDefinitionNames extracts Vue component summaries and skips ignored directories", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-code-discovery-"));

  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "views"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "src", "views", "UserPage.vue"),
      [
        "<template><div /></template>",
        "<script lang=\"ts\">",
        "import { defineComponent } from 'vue';",
        "export default defineComponent({",
        "  name: 'UserPage',",
        "  setup() {",
        "    return {};",
        "  }",
        "});",
        "</script>"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(path.join(workspaceRoot, "node_modules", "pkg", "Hidden.ts"), "export function hidden() {}\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const results = await listCodeDefinitionNames("");
    const paths = results.map((item) => item.filePath);
    const vueSummary = results.find((item) => item.filePath === "src/views/UserPage.vue");

    assert.ok(vueSummary);
    assert.equal(vueSummary.language, "vue");
    assert.deepEqual(vueSummary.definitions.map((definition) => [definition.name, definition.kind, definition.line]), [["UserPage", "component", 4]]);
    assert.equal(paths.includes("node_modules/pkg/Hidden.ts"), false);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
