import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePackageScriptExecution } from "./packageScriptResolver.js";

async function createWorkspace(context: { after: (callback: () => Promise<void>) => void }) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "package-script-resolver-"));
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  return workspaceRoot;
}

async function writePackage(workspaceRoot: string, directory: string, scripts: Record<string, string>) {
  const packageDirectory = path.join(workspaceRoot, directory);
  await fs.mkdir(packageDirectory, { recursive: true });
  await fs.writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ scripts }), "utf8");
  return packageDirectory;
}

test("未指定 cwd 时自动绑定唯一包含目标脚本的子项目", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  const packageDirectory = await writePackage(workspaceRoot, "clr-vue-app", { serve: "vue-cli-service serve" });

  const resolution = await resolvePackageScriptExecution(workspaceRoot, "npm run serve");

  assert.equal(resolution.cwd, packageDirectory);
  assert.equal(resolution.packageJsonPath, "clr-vue-app/package.json");
  assert.equal(resolution.script, "serve");
});

test("显式 cwd 优先并只校验该目录中的 package.json", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  const packageDirectory = await writePackage(workspaceRoot, "apps/web", { dev: "vite" });
  await writePackage(workspaceRoot, "apps/other", { dev: "next dev" });

  const resolution = await resolvePackageScriptExecution(workspaceRoot, "npm run dev", "apps/web");

  assert.equal(resolution.cwd, packageDirectory);
  assert.equal(resolution.packageJsonPath, "apps/web/package.json");
});

test("包管理器目录参数相对于命令 cwd 解析", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  await writePackage(workspaceRoot, "apps/web", { dev: "vite" });

  const resolution = await resolvePackageScriptExecution(workspaceRoot, "npm --prefix web run dev", "apps");

  assert.equal(resolution.cwd, path.join(workspaceRoot, "apps"));
  assert.equal(resolution.packageDirectory, path.join(workspaceRoot, "apps", "web"));
});

test("多个子项目包含同名脚本时拒绝猜测目录", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  await writePackage(workspaceRoot, "apps/web", { dev: "vite" });
  await writePackage(workspaceRoot, "apps/admin", { dev: "vite" });

  await assert.rejects(
    () => resolvePackageScriptExecution(workspaceRoot, "npm run dev"),
    /multiple directories.*apps\/admin.*apps\/web|multiple directories.*apps\/web.*apps\/admin/i
  );
});

test("拒绝工作区之外的 cwd", async (context) => {
  const workspaceRoot = await createWorkspace(context);

  await assert.rejects(
    () => resolvePackageScriptExecution(workspaceRoot, "npm run test", ".."),
    /must stay inside the workspace/i
  );
});
