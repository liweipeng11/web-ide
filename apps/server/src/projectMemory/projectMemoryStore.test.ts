import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createProjectMemoryTestWorkspace, createProjectMemoryV2Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { readProjectMemory, writeProjectMemory } from "./projectMemoryStore.js";

const execFileAsync = promisify(execFile);

test("Schema V2 固定样本可持久化并在重启后完整恢复", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const fixture = createProjectMemoryV2Fixture();

  await writeProjectMemory(workspaceRoot, fixture);

  // 使用全新的 Node 进程读取，确保恢复行为不依赖当前进程中的写入队列或模块状态。
  const moduleUrl = new URL("./projectMemoryStore.ts", import.meta.url).href;
  const script = [
    `import { readProjectMemory } from ${JSON.stringify(moduleUrl)};`,
    "const memory = await readProjectMemory(process.env.PROJECT_MEMORY_TEST_WORKSPACE);",
    "process.stdout.write(JSON.stringify(memory));"
  ].join("\n");
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: { ...process.env, PROJECT_MEMORY_TEST_WORKSPACE: workspaceRoot }
  });

  assert.deepEqual(JSON.parse(stdout), fixture);
});

test("损坏的 Project Memory 返回明确错误且不会覆盖原文件", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const memoryPath = path.join(workspaceRoot, ".mini-ai", "state", "runtime", "project-memory.json");
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, "{invalid", "utf8");

  await assert.rejects(() => readProjectMemory(workspaceRoot), /invalid JSON/);
  assert.equal(await fs.readFile(memoryPath, "utf8"), "{invalid");
});
