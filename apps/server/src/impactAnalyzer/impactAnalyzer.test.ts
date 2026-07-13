import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeImpact } from "./index.js";

async function createWorkspace(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-impact-"));
  for (const [filePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, filePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
  return root;
}

test("Impact Analyzer follows direct and indirect consumers and identifies tests", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/controller.ts": "import { loadUser } from './service.js'\nexport function getUser() { return loadUser() }\n",
    "src/routes/userRoute.ts": "import { getUser } from '../controller.js'\nexport const route = () => getUser()\n",
    "tests/user.test.ts": "import { getUser } from '../src/controller.js'\ngetUser()\n"
  });
  const result = await analyzeImpact(root, [{ filePath: "src/service.ts", symbolName: "loadUser", changeKind: "signature" }]);

  assert.equal(result.impactedFiles.find((file) => file.filePath === "src/controller.ts")?.impact, "direct");
  assert.equal(result.impactedFiles.find((file) => file.filePath === "src/routes/userRoute.ts")?.impact, "indirect");
  assert.deepEqual(result.relatedTests, ["tests/user.test.ts"]);
  assert.equal(result.boundaryFiles.includes("src/routes/userRoute.ts"), true);
  assert.equal(result.risk.level, "high");
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer keeps symbol-level analysis away from unrelated imports", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\nexport function saveUser() { return true }\n",
    "src/loadConsumer.ts": "import { loadUser } from './service.js'\nloadUser()\n",
    "src/saveConsumer.ts": "import { saveUser } from './service.js'\nsaveUser()\n"
  });
  const result = await analyzeImpact(root, [{ filePath: "src/service.ts", symbolName: "loadUser" }]);

  assert.equal(result.impactedFiles.some((file) => file.filePath === "src/loadConsumer.ts"), true);
  assert.equal(result.impactedFiles.some((file) => file.filePath === "src/saveConsumer.ts"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer treats all reverse dependencies as affected for file-level changes", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\nexport function saveUser() { return true }\n",
    "src/loadConsumer.ts": "import { loadUser } from './service.js'\nloadUser()\n",
    "src/saveConsumer.ts": "import { saveUser } from './service.js'\nsaveUser()\n"
  });
  const result = await analyzeImpact(root, [{ filePath: "src/service.ts" }]);

  assert.deepEqual(result.impactedFiles.map((file) => file.filePath).sort(), ["src/loadConsumer.ts", "src/saveConsumer.ts"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer reports missing targets instead of claiming a complete result", async () => {
  const root = await createWorkspace({ "src/service.ts": "export function loadUser() { return true }\n" });
  const result = await analyzeImpact(root, [{ filePath: "src/service.ts", symbolName: "missingUser" }]);

  assert.equal(result.changes[0].status, "missing");
  assert.equal(result.complete, false);
  assert.match(result.diagnostics[0], /未找到变更目标/);
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer enforces maxFiles and reports truncation only when candidates overflow", async () => {
  const singleConsumerRoot = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/consumer.ts": "import { loadUser } from './service.js'\nloadUser()\n"
  });
  const exactResult = await analyzeImpact(singleConsumerRoot, [{ filePath: "src/service.ts", symbolName: "loadUser" }], { maxFiles: 1 });
  assert.equal(exactResult.impactedFiles.length, 1);
  assert.equal(exactResult.truncated, false);
  await fs.rm(singleConsumerRoot, { recursive: true, force: true });

  const overflowRoot = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/consumerA.ts": "import { loadUser } from './service.js'\nloadUser()\n",
    "src/consumerB.ts": "import { loadUser } from './service.js'\nloadUser()\n"
  });
  const overflowResult = await analyzeImpact(overflowRoot, [{ filePath: "src/service.ts", symbolName: "loadUser" }], { maxFiles: 1 });
  assert.equal(overflowResult.impactedFiles.length, 1);
  assert.equal(overflowResult.truncated, true);
  assert.match(overflowResult.diagnostics.at(-1) || "", /结果已截断/);
  await fs.rm(overflowRoot, { recursive: true, force: true });
});

test("Impact Analyzer respects maxDepth and merges multiple change targets", async () => {
  const root = await createWorkspace({
    "src/userService.ts": "export function loadUser() { return true }\n",
    "src/orderService.ts": "export function loadOrder() { return true }\n",
    "src/controller.ts": "import { loadUser } from './userService.js'\nexport function getUser() { return loadUser() }\n",
    "src/entry.ts": "import { getUser } from './controller.js'\ngetUser()\n",
    "src/orderConsumer.ts": "import { loadOrder } from './orderService.js'\nloadOrder()\n"
  });
  const result = await analyzeImpact(root, [
    { filePath: "src/userService.ts", symbolName: "loadUser" },
    { filePath: "src/orderService.ts", symbolName: "loadOrder" }
  ], { maxDepth: 1 });

  assert.deepEqual(result.impactedFiles.map((file) => file.filePath).sort(), ["src/controller.ts", "src/orderConsumer.ts"]);
  assert.equal(result.impactedFiles.some((file) => file.filePath === "src/entry.ts"), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer normalizes equivalent workspace-relative paths", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/consumer.ts": "import { loadUser } from './service.js'\nloadUser()\n"
  });
  const result = await analyzeImpact(root, [{ filePath: "src/../src/service.ts", symbolName: "loadUser" }]);

  assert.equal(result.changes[0].status, "resolved");
  assert.equal(result.changes[0].filePath, "src/service.ts");
  assert.deepEqual(result.impactedFiles.map((file) => file.filePath), ["src/consumer.ts"]);
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer does not mark a result incomplete for unrelated unresolved references", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/consumer.ts": "import { loadUser } from './service.js'\nloadUser()\n",
    "src/unrelated.ts": "export function unrelated() { return missingDependency() }\n"
  });
  const result = await analyzeImpact(root, [{ filePath: "src/service.ts", symbolName: "loadUser" }]);

  assert.equal(result.indexedUnresolvedReferenceCount > 0, true);
  assert.equal(result.unresolvedReferenceCount, 0);
  assert.equal(result.complete, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("Impact Analyzer marks unresolved references to the changed symbol as incomplete", async () => {
  const root = await createWorkspace({
    "src/service.ts": "export function loadUser() { return true }\n",
    "src/consumer.ts": "import { loadUser } from './service.js'\nloadUser()\n",
    "src/unresolvedConsumer.ts": "export function run() { return loadUser() }\n"
  });
  const result = await analyzeImpact(root, [{ filePath: "src/service.ts", symbolName: "loadUser" }]);

  assert.equal(result.unresolvedReferenceCount > 0, true);
  assert.equal(result.complete, false);
  assert.match(result.diagnostics.at(-1) || "", /本次影响链存在/);
  await fs.rm(root, { recursive: true, force: true });
});
