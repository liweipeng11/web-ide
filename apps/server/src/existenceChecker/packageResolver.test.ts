import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePackageImport } from "./packageResolver.js";

async function createWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-package-resolver-"));
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
}

test("解析子包已声明且已安装的依赖", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeJson(path.join(workspaceRoot, "apps", "web", "package.json"), { dependencies: { "vue-router": "^3.6.5" } });
  await writeJson(path.join(workspaceRoot, "apps", "web", "node_modules", "vue-router", "package.json"), { name: "vue-router" });

  const result = await resolvePackageImport({
    workspaceRoot,
    specifier: "vue-router",
    fromPath: "apps/web/src/router/index.js"
  });

  assert.equal(result.status, "dependency_installed");
  assert.equal(result.blocking, false);
  assert.equal(result.packageRoot, "apps/web");
  assert.equal(result.resolvedPath, "apps/web/node_modules/vue-router/package.json");
});

test("区分已声明未安装与完全未声明的依赖", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeJson(path.join(workspaceRoot, "packages", "feature", "package.json"), {
    devDependencies: { "declared-lib": "^1.0.0" }
  });

  const declared = await resolvePackageImport({
    workspaceRoot,
    specifier: "declared-lib",
    fromPath: "packages/feature/src/index.ts"
  });
  const missing = await resolvePackageImport({
    workspaceRoot,
    specifier: "missing-lib",
    fromPath: "packages/feature/src/index.ts"
  });

  assert.equal(declared.status, "dependency_declared");
  assert.equal(declared.packageRoot, "packages/feature");
  assert.equal(missing.status, "truly_missing");
});

test("根目录和子包都安装同名依赖时优先使用最近子包", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeJson(path.join(workspaceRoot, "package.json"), { dependencies: { "shared-lib": "^1.0.0" } });
  await writeJson(path.join(workspaceRoot, "node_modules", "shared-lib", "package.json"), { name: "shared-lib", version: "1.0.0" });
  await writeJson(path.join(workspaceRoot, "apps", "web", "package.json"), { dependencies: { "shared-lib": "^2.0.0" } });
  await writeJson(path.join(workspaceRoot, "apps", "web", "node_modules", "shared-lib", "package.json"), { name: "shared-lib", version: "2.0.0" });

  const result = await resolvePackageImport({
    workspaceRoot,
    specifier: "shared-lib",
    fromPath: "apps/web/src/index.ts"
  });

  assert.equal(result.status, "dependency_installed");
  assert.equal(result.resolvedPath, "apps/web/node_modules/shared-lib/package.json");
  assert.equal(result.candidates.length, 1);
});

test("支持工作区包子路径并阻止越界发起路径", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeJson(path.join(workspaceRoot, "packages", "core", "package.json"), { name: "@demo/core" });
  await fs.mkdir(path.join(workspaceRoot, "packages", "core", "utils"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "packages", "core", "utils", "format.ts"), "export const format = true;\n", "utf8");

  const workspacePackage = await resolvePackageImport({
    workspaceRoot,
    specifier: "@demo/core/utils/format",
    fromPath: "apps/web/src/index.ts"
  });
  const escaped = await resolvePackageImport({
    workspaceRoot,
    specifier: "@demo/core",
    fromPath: "../outside/index.ts"
  });

  assert.equal(workspacePackage.status, "existing");
  assert.equal(workspacePackage.resolvedPath, "packages/core/utils/format.ts");
  assert.equal(escaped.status, "unknown");
  assert.equal(escaped.blocking, true);
});
