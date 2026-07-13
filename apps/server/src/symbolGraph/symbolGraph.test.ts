import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSymbolGraph, parseSourceFile, querySymbolGraph } from "./index.js";

async function createWorkspace(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "symbol-graph-"));
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return root;
}

test("parseSourceFile indexes functions, classes, React components, types, constants and exports", () => {
  const parsed = parseSourceFile(
    [
      "export interface User { id: string }",
      "export type UserId = User['id']",
      "export class UserService {}",
      "export function loadUser(): User { throw new Error() }",
      "export const DEFAULT_USER_ID = '1'",
      "export const UserCard = () => <div />"
    ].join("\n"),
    "src/users.tsx"
  );

  assert.deepEqual(parsed.symbols.map((symbol) => [symbol.name, symbol.kind]), [
    ["User", "interface"],
    ["UserId", "type"],
    ["UserService", "class"],
    ["loadUser", "function"],
    ["DEFAULT_USER_ID", "constant"],
    ["UserCard", "component"]
  ]);
  assert.equal(parsed.symbols.every((symbol) => symbol.exported), true);
});

test("parseSourceFile indexes qualified React HOCs and anonymous default components", () => {
  const wrapped = parseSourceFile("export const UserCard = React.memo(() => <div />)\n", "src/UserCard.tsx");
  const anonymous = parseSourceFile("export default () => <main />\n", "src/Dashboard.tsx");

  assert.equal(wrapped.symbols.find((symbol) => symbol.name === "UserCard")?.kind, "component");
  assert.equal(anonymous.symbols.some((symbol) => symbol.name === "Dashboard" && symbol.kind === "component" && symbol.defaultExport), true);
});

test("parseSourceFile indexes Vue default components and preserves script line numbers", () => {
  const parsed = parseSourceFile(
    ["<template><div /></template>", "<script lang=\"ts\">", "export default { name: 'UserPanel' }", "</script>"].join("\n"),
    "src/UserPanel.vue"
  );
  const component = parsed.symbols.find((symbol) => symbol.kind === "component");

  assert.equal(component?.name, "UserPanel");
  assert.equal(component?.defaultExport, true);
  assert.equal(component?.line, 3);
});

test("Symbol Graph resolves definitions, references, reverse dependencies and call chains", async () => {
  const root = await createWorkspace({
    "src/service.ts": ["export interface User { id: string }", "export function loadUser(): User { return { id: '1' } }"].join("\n"),
    "src/controller.ts": ["import { loadUser, User } from './service.js'", "export function getUser(): User { return loadUser() }"].join("\n"),
    "src/route.ts": ["import { getUser } from './controller.js'", "export function handleRoute() { return getUser() }"].join("\n")
  });
  const graph = await buildSymbolGraph(root);

  const definitions = querySymbolGraph(graph, { kind: "definition", symbolName: "loadUser" });
  const references = querySymbolGraph(graph, { kind: "references", symbolName: "loadUser" });
  const reverseDependencies = querySymbolGraph(graph, { kind: "reverseDependencies", filePath: "src/service.ts" });
  const calls = querySymbolGraph(graph, { kind: "callChain", symbolName: "loadUser", direction: "incoming", maxDepth: 3 });

  assert.equal(definitions.definitions[0]?.filePath, "src/service.ts");
  assert.equal(references.references.some((reference) => reference.filePath === "src/controller.ts" && reference.kind === "call"), true);
  assert.deepEqual(reverseDependencies.dependencies.map((dependency) => dependency.fromFile).sort(), ["src/controller.ts", "src/route.ts"]);
  assert.deepEqual(calls.relations.map((relation) => relation.from?.name), ["getUser", "handleRoute"]);
});

test("Symbol Graph follows type propagation and reports ambiguous definitions", async () => {
  const root = await createWorkspace({
    "src/model.ts": "export interface User { id: string }\nexport type UserList = User[]\n",
    "src/view.ts": "import type { UserList } from './model.js'\nexport type ViewState = UserList | null\n",
    "src/duplicate.ts": "export interface User { name: string }\n"
  });
  const graph = await buildSymbolGraph(root);
  const propagation = querySymbolGraph(graph, { kind: "typePropagation", symbolName: "UserList", direction: "both" });
  const ambiguous = querySymbolGraph(graph, { kind: "definition", symbolName: "User" });

  assert.equal(propagation.relations.some((relation) => relation.from?.name === "ViewState"), true);
  assert.equal(propagation.relations.some((relation) => relation.to?.name === "User"), true);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.definitions.length, 2);
});

test("Symbol Graph resolves re-exports and class method calls", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/public.ts": "export { loadUser } from './service.js'\n",
    "src/controller.ts": ["import { loadUser } from './public.js'", "export class Controller {", "  run() { return loadUser() }", "}"].join("\n")
  });
  const graph = await buildSymbolGraph(root);
  const result = querySymbolGraph(graph, { kind: "references", symbolName: "loadUser", filePath: "src/service.ts" });

  assert.equal(graph.dependencies.some((dependency) => dependency.fromFile === "src/public.ts" && dependency.toFile === "src/service.ts"), true);
  assert.equal(result.references.some((reference) => reference.filePath === "src/public.ts" && reference.kind === "import"), true);
});

test("TypeChecker binds shadowed variables to the nearest lexical declaration", async () => {
  const root = await createWorkspace({
    "src/scope.ts": ["export const value = 1", "export function readValue() {", "  const value = 2", "  return value", "}"].join("\n")
  });
  const graph = await buildSymbolGraph(root);
  const values = graph.symbols.filter((symbol) => symbol.name === "value");
  const localValue = values.find((symbol) => !symbol.exported);
  const returnReference = graph.references.find((reference) => reference.name === "value" && reference.line === 4);

  assert.equal(values.length, 2);
  assert.equal(returnReference?.targetSymbolId, localValue?.id);
});

test("Symbol Graph resolves default exports and aliased local exports", async () => {
  const root = await createWorkspace({
    "src/service.ts": ["const loadDefault = () => true", "const loadNamed = () => true", "export default loadDefault", "export { loadNamed as fetchUser }"].join("\n"),
    "src/controller.ts": ["import loadDefault, { fetchUser } from './service.js'", "export function run() {", "  loadDefault()", "  return fetchUser()", "}"].join("\n")
  });
  const graph = await buildSymbolGraph(root);
  const defaultSymbol = graph.symbols.find((symbol) => symbol.name === "loadDefault");
  const namedSymbol = graph.symbols.find((symbol) => symbol.name === "loadNamed");
  const calls = graph.references.filter((reference) => reference.kind === "call" && reference.filePath === "src/controller.ts");

  assert.equal(defaultSymbol?.defaultExport, true);
  assert.equal(namedSymbol?.exported, true);
  assert.equal(calls.find((reference) => reference.name === "loadDefault")?.targetSymbolId, defaultSymbol?.id);
  assert.equal(calls.find((reference) => reference.name === "fetchUser")?.targetSymbolId, namedSymbol?.id);
});

test("Symbol Graph resolves export-star barrels and namespace member calls", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/public.ts": "export * from './service.js'\n",
    "src/controller.ts": "import * as api from './public.js'\nexport function run() { return api.loadUser() }\n"
  });
  const graph = await buildSymbolGraph(root);
  const definition = graph.symbols.find((symbol) => symbol.name === "loadUser");
  const call = graph.references.find((reference) => reference.filePath === "src/controller.ts" && reference.name === "loadUser");

  assert.equal(call?.kind, "call");
  assert.equal(call?.targetSymbolId, definition?.id);
  assert.equal(graph.dependencies.find((dependency) => dependency.fromFile === "src/public.ts")?.toFile, "src/service.ts");
});

test("Symbol Graph reads tsconfig paths aliases", async () => {
  const root = await createWorkspace({
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/controller.ts": "import { loadUser } from '@/service'\nexport function run() { return loadUser() }\n"
  });
  const graph = await buildSymbolGraph(root);
  const dependency = graph.dependencies.find((item) => item.fromFile === "src/controller.ts");
  const call = graph.references.find((reference) => reference.filePath === "src/controller.ts" && reference.kind === "call" && reference.name === "loadUser");

  assert.equal(dependency?.toFile, "src/service.ts");
  assert.equal(Boolean(call?.targetSymbolId), true);
});

test("parseSourceFile combines Vue scripts and indexes script-setup component", () => {
  const parsed = parseSourceFile(
    [
      "<script lang=\"ts\">",
      "export const legacyValue = 1",
      "</script>",
      "<script setup lang=\"ts\">",
      "const count = 1",
      "</script>"
    ].join("\n"),
    "src/CounterPanel.vue"
  );

  assert.equal(parsed.symbols.some((symbol) => symbol.name === "CounterPanel" && symbol.kind === "component" && symbol.defaultExport), true);
  assert.equal(parsed.symbols.find((symbol) => symbol.name === "legacyValue")?.line, 2);
  assert.equal(parsed.symbols.find((symbol) => symbol.name === "count")?.line, 5);
});

test("Symbol Graph links TypeScript consumers to Vue script-setup components", async () => {
  const root = await createWorkspace({
    "src/UserPanel.vue": "<script setup lang=\"ts\">\nconst title = 'user'\n</script>\n",
    "src/App.tsx": "import UserPanel from './UserPanel.vue'\nexport const App = () => <UserPanel />\n"
  });
  const graph = await buildSymbolGraph(root);
  const component = graph.symbols.find((symbol) => symbol.name === "UserPanel" && symbol.kind === "component");
  const jsxReference = graph.references.find((reference) => reference.filePath === "src/App.tsx" && reference.name === "UserPanel" && reference.kind === "reference");

  assert.equal(Boolean(component), true);
  assert.equal(jsxReference?.targetSymbolId, component?.id);
});

test("Symbol Graph indexes Vue template component references", async () => {
  const root = await createWorkspace({
    "src/UserCard.vue": "<script setup lang=\"ts\">\nconst title = 'user'\n</script>\n",
    "src/UserPage.vue": ["<template><user-card /></template>", "<script setup lang=\"ts\">", "import UserCard from './UserCard.vue'", "</script>"].join("\n")
  });
  const graph = await buildSymbolGraph(root);
  const component = graph.symbols.find((symbol) => symbol.name === "UserCard" && symbol.filePath === "src/UserCard.vue");
  const templateReference = graph.references.find((reference) => reference.filePath === "src/UserPage.vue" && reference.name === "UserCard" && reference.line === 1);

  assert.equal(templateReference?.targetSymbolId, component?.id);
});

test("TypeChecker distinguishes methods with the same name by receiver type", async () => {
  const root = await createWorkspace({
    "src/methods.ts": [
      "export class Reader { run() { return 'read' } }",
      "export class Writer { run() { return 'write' } }",
      "export function execute(reader: Reader, writer: Writer) {",
      "  reader.run()",
      "  return writer.run()",
      "}"
    ].join("\n")
  });
  const graph = await buildSymbolGraph(root);
  const methods = graph.symbols.filter((symbol) => symbol.name === "run");
  const calls = graph.references.filter((reference) => reference.kind === "call" && reference.name === "run");

  assert.equal(methods.length, 2);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].targetSymbolId, calls[1].targetSymbolId);
  assert.equal(calls.every((call) => methods.some((method) => method.id === call.targetSymbolId)), true);
});

test("type propagation includes TypeChecker-inferred variable types", async () => {
  const root = await createWorkspace({
    "src/inference.ts": ["export interface User { id: string }", "export function loadUser(): User { return { id: '1' } }", "export const currentUser = loadUser()"].join("\n")
  });
  const graph = await buildSymbolGraph(root);
  const user = graph.symbols.find((symbol) => symbol.name === "User");
  const currentUser = graph.symbols.find((symbol) => symbol.name === "currentUser");
  const inferredEdge = graph.references.find((reference) => reference.kind === "type" && reference.sourceSymbolId === currentUser?.id && reference.targetSymbolId === user?.id);

  assert.equal(Boolean(inferredEdge), true);
});

test("Symbol Graph exposes file-index truncation to query callers", async () => {
  const root = await createWorkspace({
    "src/a.ts": "export const a = 1\n",
    "src/b.ts": "export const b = 2\n"
  });
  const graph = await buildSymbolGraph(root, { maxFiles: 1 });
  const result = querySymbolGraph(graph, { kind: "definition", symbolName: graph.symbols[0].name });

  assert.equal(graph.files.length, 1);
  assert.equal(graph.indexTruncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.indexTruncated, true);
});

test("Symbol Graph reuses unchanged indexes and invalidates cache after source changes", async () => {
  const root = await createWorkspace({ "src/value.ts": "export const oldValue = 1\n" });
  const first = await buildSymbolGraph(root);
  const second = await buildSymbolGraph(root);
  await fs.writeFile(path.join(root, "src/value.ts"), "export const updatedValue = 100\n", "utf8");
  const updated = await buildSymbolGraph(root);

  assert.equal(second, first);
  assert.notEqual(updated, first);
  assert.equal(updated.symbols.some((symbol) => symbol.name === "updatedValue"), true);
});
