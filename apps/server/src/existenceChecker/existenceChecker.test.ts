import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkCodeImports, checkExistence, extractImportReferences } from "./existenceChecker.js";

async function createWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-existence-checker-"));
}

test("检查器能确认相对 import、脚本、环境变量和目录", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src", "services"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "services", "user.ts"), "export function getUser() {}\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".env.example"), "API_TOKEN=placeholder\n", "utf8");

  const result = await checkExistence(workspaceRoot, [
    { kind: "import", value: "./services/user", fromPath: "src/app.ts" },
    { kind: "script", value: "test" },
    { kind: "environment", value: "API_TOKEN" },
    { kind: "directory", value: "src/services" }
  ]);

  assert.deepEqual(result.checks.map((check) => check.status), ["exists", "exists", "exists", "exists"]);
  assert.equal(result.summary.exists, 4);
});

test("检查器报告缺失的 import 和脚本", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: {} }), "utf8");

  const result = await checkExistence(workspaceRoot, [
    { kind: "import", value: "./missing", fromPath: "src/app.ts" },
    { kind: "script", value: "typecheck" }
  ]);

  assert.deepEqual(result.checks.map((check) => check.status), ["missing", "missing"]);
  assert.equal(result.summary.missing, 2);
});

test("检查器在同名符号有多个候选时标记歧义，并优先使用有效环境配置", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "first.ts"), "export function formatValue() {}\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "second.ts"), "export function formatValue() {}\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".env"), "API_TOKEN=local\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".env.example"), "API_TOKEN=placeholder\n", "utf8");

  const result = await checkExistence(workspaceRoot, [{ kind: "symbol", value: "formatValue" }, { kind: "environment", value: "API_TOKEN" }]);

  assert.deepEqual(result.checks.map((check) => check.status), ["ambiguous", "exists"]);
  assert.equal(result.summary.ambiguous, 1);
});

test("提取并校验代码中的静态 import", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "client.ts"), "export const client = {};\n", "utf8");
  const content = "import { client } from './client';\nexport { client as api } from './client';\n";

  assert.deepEqual(extractImportReferences(content).map((item) => item.specifier), ["./client"]);
  const result = await checkCodeImports(workspaceRoot, content, "src/app.ts");
  assert.equal(result.result.summary.exists, 1);
});

test("检查器解析 tsconfig 路径别名、工作区包与已安装包", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src", "shared"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "packages", "core", "utils"), { recursive: true });
  await fs.mkdir(path.join(workspaceRoot, "node_modules", "tiny-lib"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }), "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "shared", "value.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "packages", "core", "package.json"), JSON.stringify({ name: "@demo/core" }), "utf8");
  await fs.writeFile(path.join(workspaceRoot, "packages", "core", "utils", "format.ts"), "export const format = true;\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "node_modules", "tiny-lib", "package.json"), JSON.stringify({ name: "tiny-lib" }), "utf8");

  const result = await checkExistence(workspaceRoot, [
    { kind: "import", value: "@/shared/value" },
    { kind: "import", value: "@demo/core/utils/format" },
    { kind: "import", value: "tiny-lib" }
  ]);
  assert.deepEqual(result.checks.map((check) => check.status), ["exists", "exists", "exists"]);
});

test("检查器识别 Python、Vue 符号，并忽略示例环境文件造成的假歧义", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "worker.py"), "class Worker:\n    pass\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, "src", "UserCard.vue"), "<template><div /></template>\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".env"), "API_TOKEN=local\n", "utf8");
  await fs.writeFile(path.join(workspaceRoot, ".env.example"), "API_TOKEN=example\n", "utf8");

  const result = await checkExistence(workspaceRoot, [{ kind: "symbol", value: "Worker" }, { kind: "symbol", value: "UserCard" }, { kind: "environment", value: "API_TOKEN" }]);
  assert.deepEqual(result.checks.map((check) => check.status), ["exists", "exists", "exists"]);
});
