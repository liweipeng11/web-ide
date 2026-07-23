import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolvePathAlias } from "./aliasResolver.js";

async function createWorkspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-alias-resolver-"));
}

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

test("按优先级解析最近包的 tsconfig 和 jsconfig paths", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, "package.json"), "{}");
  await writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@root/*": ["root/*"] } } }));
  await writeFile(path.join(workspaceRoot, "root", "value.ts"), "export const root = true;\n");
  await writeFile(path.join(workspaceRoot, "apps", "web", "package.json"), "{}");
  await writeFile(path.join(workspaceRoot, "apps", "web", "jsconfig.json"), `{
    // JSONC 注释和尾逗号是 TypeScript 配置的合法常见写法
    "compilerOptions": {
      "baseUrl": ".",
      "paths": { "#/*": ["src/*"], },
    },
  }`);
  await writeFile(path.join(workspaceRoot, "apps", "web", "src", "value.js"), "export const value = true;\n");

  const tsconfig = await resolvePathAlias({ workspaceRoot, specifier: "@root/value", fromPath: "apps/web/src/app.js" });
  const jsconfig = await resolvePathAlias({ workspaceRoot, specifier: "#/value", fromPath: "apps/web/src/app.js" });

  assert.equal(tsconfig?.status, "existing");
  assert.equal(tsconfig?.resolvedPath, "root/value.ts");
  assert.equal(jsconfig?.status, "existing");
  assert.equal(jsconfig?.resolvedPath, "apps/web/src/value.js");
});

test("解析 Vue CLI 默认 @ 到当前包 src", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, "clr-vue-app", "package.json"), JSON.stringify({ dependencies: { vue: "^2.7.16" } }));
  await writeFile(path.join(workspaceRoot, "clr-vue-app", "src", "views", "createuserid.vue"), "<template />\n");

  const result = await resolvePathAlias({
    workspaceRoot,
    specifier: "@/views/createuserid.vue",
    fromPath: "clr-vue-app/src/router/index.js"
  });

  assert.equal(result?.status, "existing");
  assert.equal(result?.packageRoot, "clr-vue-app");
  assert.equal(result?.resolvedPath, "clr-vue-app/src/views/createuserid.vue");
});

test("安全提取 vue.config.js 与 vite.config.ts 的静态 alias", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, "package.json"), "{}");
  await writeFile(path.join(workspaceRoot, "src", "shared", "api.ts"), "export const api = true;\n");
  await writeFile(path.join(workspaceRoot, "src", "features", "card.ts"), "export const card = true;\n");
  await writeFile(path.join(workspaceRoot, "vue.config.js"), "module.exports = { configureWebpack: { resolve: { alias: { '~shared': 'src/shared' } } } };\n");
  await writeFile(path.join(workspaceRoot, "vite.config.ts"), "export default { resolve: { alias: { '#features': './src/features' } } };\n");

  const vueAlias = await resolvePathAlias({ workspaceRoot, specifier: "~shared/api", fromPath: "src/app.ts" });
  const viteAlias = await resolvePathAlias({ workspaceRoot, specifier: "#features/card", fromPath: "src/app.ts" });

  assert.equal(vueAlias?.resolvedPath, "src/shared/api.ts");
  assert.equal(viteAlias?.resolvedPath, "src/features/card.ts");
});

test("支持 Vue chainWebpack set 与 Vite alias 数组的静态形式", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, "package.json"), "{}");
  await writeFile(path.join(workspaceRoot, "src", "chain", "value.ts"), "export const value = true;\n");
  await writeFile(path.join(workspaceRoot, "src", "array", "value.ts"), "export const value = true;\n");
  await writeFile(path.join(workspaceRoot, "vue.config.js"), "module.exports = { chainWebpack: config => config.resolve.alias.set('~chain', path.resolve(__dirname, 'src/chain')) };\n");
  await writeFile(path.join(workspaceRoot, "vite.config.ts"), "export default { resolve: { alias: [{ find: '#array', replacement: path.resolve(__dirname, 'src/array') }] } };\n");

  const chainAlias = await resolvePathAlias({ workspaceRoot, specifier: "~chain/value", fromPath: "src/app.ts" });
  const arrayAlias = await resolvePathAlias({ workspaceRoot, specifier: "#array/value", fromPath: "src/app.ts" });

  assert.equal(chainAlias?.resolvedPath, "src/chain/value.ts");
  assert.equal(arrayAlias?.resolvedPath, "src/array/value.ts");
});

test("动态 alias 返回 unknown，越界 alias 保持阻断", async (context) => {
  const workspaceRoot = await createWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await writeFile(path.join(workspaceRoot, "package.json"), "{}");
  await writeFile(path.join(workspaceRoot, "vite.config.ts"), "export default { resolve: { alias: { [process.env.ALIAS]: './src' } } };\n");

  const dynamic = await resolvePathAlias({ workspaceRoot, specifier: "#dynamic/value", fromPath: "src/app.ts" });
  await writeFile(path.join(workspaceRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@outside/*": ["../outside/*"] } } }));
  const escaped = await resolvePathAlias({ workspaceRoot, specifier: "@outside/value", fromPath: "src/app.ts" });

  assert.equal(dynamic?.status, "unknown");
  assert.equal(dynamic?.blocking, true);
  assert.equal(escaped?.status, "unknown");
  assert.match(escaped?.reason || "", /超出工作区/);
});
