import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonStateFile, requireStateFileVersion, StateFileError, writeJsonStateFile } from "./stateFileStorage.js";

async function withTemporaryState(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-state-storage-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("UTF-8 中文状态可原子写入并被标准 JSON 解析器读取", async () => {
  await withTemporaryState(async (directory) => {
    const filePath = path.join(directory, "state.json");
    const state = { messages: ["编辑任务没有生成补丁，也没有产生已应用文件变更。", "创建用户页面", "构建验证通过"] };
    await writeJsonStateFile(filePath, state);
    assert.deepEqual(await readJsonStateFile(filePath), state);
    assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), state);
  });
});

test("非法 UTF-8 和损坏 JSON 使用稳定错误分类且不会被静默覆盖", async () => {
  await withTemporaryState(async (directory) => {
    const encodingPath = path.join(directory, "encoding.json");
    await fs.writeFile(encodingPath, Buffer.from([0xc3, 0x28]));
    await assert.rejects(() => readJsonStateFile(encodingPath), (error: unknown) => error instanceof StateFileError && error.code === "STATE_FILE_ENCODING_ERROR");

    const jsonPath = path.join(directory, "invalid.json");
    await fs.writeFile(jsonPath, "{损坏", "utf8");
    await assert.rejects(() => readJsonStateFile(jsonPath), (error: unknown) => error instanceof StateFileError && error.code === "STATE_FILE_INVALID_JSON");
    assert.equal(await fs.readFile(jsonPath, "utf8"), "{损坏");
  });
});

test("目标损坏时从备份恢复读取并保留损坏原文件", async () => {
  await withTemporaryState(async (directory) => {
    const filePath = path.join(directory, "recover.json");
    await fs.writeFile(filePath, "{broken", "utf8");
    await fs.writeFile(`${filePath}.bak`, JSON.stringify({ message: "构建验证通过" }), "utf8");
    assert.deepEqual(await readJsonStateFile(filePath, { recover: true }), { message: "构建验证通过" });
    assert.equal(await fs.readFile(filePath, "utf8"), "{broken");
    assert.equal((await fs.readdir(directory)).some((name) => name.startsWith("recover.json.corrupt-")), true);
  });
});

test("崩溃遗留的完整临时文件可优先用于安全恢复", async () => {
  await withTemporaryState(async (directory) => {
    const filePath = path.join(directory, "temporary-recovery.json");
    const temporaryPath = path.join(directory, ".temporary-recovery.json.crash.tmp");
    await fs.writeFile(filePath, "{broken", "utf8");
    await fs.writeFile(temporaryPath, JSON.stringify({ message: "编辑任务没有生成补丁，也没有产生已应用文件变更。" }), "utf8");

    assert.deepEqual(await readJsonStateFile(filePath, { recover: true }), {
      message: "编辑任务没有生成补丁，也没有产生已应用文件变更。"
    });
    const diagnostics = await fs.readFile(path.join(directory, "state-storage-diagnostics.jsonl"), "utf8");
    assert.match(diagnostics, /STATE_FILE_INVALID_JSON/);
    assert.doesNotMatch(diagnostics, /\{broken/);
  });
});

test("并发写入始终生成完整 JSON 且不遗留临时文件", async () => {
  await withTemporaryState(async (directory) => {
    const filePath = path.join(directory, "concurrent.json");
    await Promise.all(Array.from({ length: 50 }, (_, index) => writeJsonStateFile(filePath, { index, text: `中文-${index}` })));
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { index: number; text: string };
    assert.equal(parsed.index, 49);
    assert.equal(parsed.text, "中文-49");
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  });
});

test("缺失文件和不支持版本可被调用方明确区分", async () => {
  await withTemporaryState(async (directory) => {
    const missingPath = path.join(directory, "missing.json");
    await assert.rejects(() => readJsonStateFile(missingPath), (error: unknown) => error instanceof StateFileError && error.code === "STATE_FILE_NOT_FOUND");
    assert.equal(await readJsonStateFile(missingPath, { allowMissing: true }), null);

    const versionPath = path.join(directory, "version.json");
    await fs.writeFile(versionPath, JSON.stringify({ schemaVersion: 2 }), "utf8");
    await assert.rejects(
      () => readJsonStateFile(versionPath, { validate: requireStateFileVersion(1) }),
      (error: unknown) => error instanceof StateFileError && error.code === "STATE_FILE_VERSION_UNSUPPORTED"
    );
  });
});
