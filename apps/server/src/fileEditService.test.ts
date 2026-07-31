import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import { replaceInFile, SearchReplaceMismatchError, writeFile } from "./fileEditService.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

async function withTempWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-file-edit-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function setStablePastMtime(filePath: string) {
  // 使用固定的过去时间，确保误写盘时 mtime 变化能够被稳定检测。
  const stableTime = new Date("2020-01-02T03:04:05.000Z");
  await fs.utimes(filePath, stableTime, stableTime);
  return (await fs.stat(filePath)).mtimeMs;
}

test("replaceInFile 可以替换单个精确片段", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "hello.txt"), "hello world\nhello codex\n", "utf8");

    const result = await replaceInFile({
      filePath: "hello.txt",
      search: "hello",
      replace: "hi"
    });

    assert.equal(result.oldContent, "hello world\nhello codex\n");
    assert.equal(result.finalContent, "hi world\nhello codex\n");
    assert.equal(result.changed, true);
    assert.equal(result.replacements, 1);
  });
});

test("replaceInFile 找不到 search 时抛出可识别错误", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "hello.txt"), "hello world\n", "utf8");

    await assert.rejects(
      () =>
        replaceInFile({
          filePath: "hello.txt",
          search: "missing",
          replace: "unused"
        }),
      SearchReplaceMismatchError
    );
  });
});

test("replaceInFile 拒绝工作区外的绝对路径", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const absoluteFilePath = path.join(workspaceRoot, "hello.txt");
    await fs.writeFile(absoluteFilePath, "hello world\n", "utf8");

    await assert.rejects(
      () =>
        replaceInFile({
          filePath: absoluteFilePath,
          search: "hello",
          replace: "hi"
        }),
      (error: unknown) => error instanceof HttpError && error.status === 403
    );
  });
});

test("replaceInFile 支持 replaceAll 替换全部命中", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "hello.txt"), "a b a b a\n", "utf8");

    const result = await replaceInFile({
      filePath: "hello.txt",
      search: "a",
      replace: "x",
      replaceAll: true
    });

    assert.equal(result.finalContent, "x b x b x\n");
    assert.equal(result.replacements, 3);
  });
});

test("writeFile 可以覆盖已有文件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "old content", "utf8");

    const result = await writeFile({
      filePath: "note.txt",
      content: "new content"
    });

    assert.equal(result.oldContent, "old content");
    assert.equal(result.finalContent, "new content");
    assert.equal(result.changed, true);
  });
});

test("writeFile 默认不创建不存在的文件", async () => {
  await withTempWorkspace(async () => {
    await assert.rejects(
      () =>
        writeFile({
          filePath: "missing.txt",
          content: "new content"
        }),
      (error: unknown) => error instanceof HttpError && error.status === 404
    );
  });
});

test("writeFile 拒绝工作区外的绝对路径", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await assert.rejects(
      () =>
        writeFile({
          filePath: path.join(workspaceRoot, "absolute.txt"),
          content: "new content",
          createIfMissing: true
        }),
      (error: unknown) => error instanceof HttpError && error.status === 403
    );
  });
});

test("writeFile 在 createIfMissing=true 时创建文件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const result = await writeFile({
      filePath: "nested/new-file.txt",
      content: "created content",
      createIfMissing: true
    });

    assert.equal(result.oldContent, "");
    assert.equal(result.finalContent, "created content");
    assert.equal(result.changed, true);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "nested", "new-file.txt"), "utf8"), "created content");
  });
});

test("replaceInFile 搜索和替换内容相同时不写盘", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const filePath = path.join(workspaceRoot, "hello.txt");
    await fs.writeFile(filePath, "hello world\n", "utf8");
    const previousMtimeMs = await setStablePastMtime(filePath);

    const result = await replaceInFile({
      filePath: "hello.txt",
      search: "hello",
      replace: "hello"
    });

    assert.equal(result.oldContent, "hello world\n");
    assert.equal(result.finalContent, "hello world\n");
    assert.equal(result.changed, false);
    assert.equal(result.replacements, 1);
    assert.equal((await fs.stat(filePath)).mtimeMs, previousMtimeMs);
  });
});

test("writeFile 写入相同内容时不写盘并返回完整内容", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const filePath = path.join(workspaceRoot, "note.txt");
    await fs.writeFile(filePath, "same content\n", "utf8");
    const previousMtimeMs = await setStablePastMtime(filePath);

    const result = await writeFile({
      filePath: "note.txt",
      content: "same content\n"
    });

    assert.equal(result.oldContent, "same content\n");
    assert.equal(result.finalContent, "same content\n");
    assert.equal(result.changed, false);
    assert.equal(result.beforeExists, true);
    assert.equal((await fs.stat(filePath)).mtimeMs, previousMtimeMs);
  });
});

test("writeFile 将空格和换行差异视为真实变更", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const filePath = path.join(workspaceRoot, "format.txt");
    await fs.writeFile(filePath, "line one\nline two\n", "utf8");

    const result = await writeFile({
      filePath: "format.txt",
      content: "line one \r\nline two\n"
    });

    assert.equal(result.changed, true);
    assert.equal(result.finalContent, "line one \r\nline two\n");
    assert.equal(await fs.readFile(filePath, "utf8"), "line one \r\nline two\n");
  });
});
