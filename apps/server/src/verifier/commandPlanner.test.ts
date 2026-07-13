import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { orderVerificationCommands, planVerificationCommands } from "./commandPlanner.js";

test("按格式语法、类型、lint、测试、构建顺序规划命令并去重", () => {
  const commands = orderVerificationCommands([
    { name: "build", command: "pnpm build", source: "package.json", reason: "构建" },
    { name: "test", command: "pnpm test", source: "package.json", reason: "测试" },
    { name: "typecheck", command: "pnpm typecheck", source: "package.json", reason: "类型" },
    { name: "lint", command: "pnpm lint", source: "package.json", reason: "检查" },
    { name: "check", command: "pnpm check", source: "package.json", reason: "语法" },
    { name: "test:duplicate", command: "pnpm test", source: "other", reason: "重复" }
  ]);

  assert.deepEqual(commands.map((item) => item.stage), ["format_syntax", "typecheck", "lint", "test", "build"]);
  assert.equal(commands.length, 5);
});

test("从项目配置自动发现可执行的验证流水线", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "verifier-plan-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts: { build: "vite build", "test:unit": "vitest run", "lint:ci": "eslint .", typecheck: "tsc --noEmit" } }), "utf8");
  await fs.writeFile(path.join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

  const commands = await planVerificationCommands(directory);

  assert.deepEqual(commands.map((item) => item.command), ["pnpm typecheck", "pnpm lint:ci", "pnpm test:unit", "pnpm build"]);

  const commandsWithSuggestion = await planVerificationCommands(directory, "pnpm test:focused");
  assert.deepEqual(commandsWithSuggestion.map((item) => item.command), ["pnpm typecheck", "pnpm lint:ci", "pnpm test:unit", "pnpm test:focused", "pnpm build"]);
});
