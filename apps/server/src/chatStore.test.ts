import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ChatStoreRepository } from "./chatStore.js";
import { StateFileError } from "./stateFileStorage.js";

test("聊天状态并发更新不会丢失中文消息且可在重启后恢复", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-chat-store-"));
  const filePath = path.join(directory, "chat-store.json");
  try {
    const repository = new ChatStoreRepository(filePath);
    await Promise.all(Array.from({ length: 20 }, (_, index) => repository.update((store) => {
      store.conversations[`chat:${index}`] = [{
        id: String(index), role: "assistant", content: `创建用户页面-${index}`, createdAt: new Date(0).toISOString()
      }];
    })));
    const restartedRepository = new ChatStoreRepository(filePath);
    const restored = await restartedRepository.read();
    assert.equal(Object.keys(restored.conversations).length, 20);
    assert.equal(restored.conversations["chat:19"]?.[0]?.content, "创建用户页面-19");
    assert.doesNotThrow(() => JSON.parse(awaitText(filePath)));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("聊天状态损坏时不会回退为空对象或覆盖原文件", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-chat-corrupt-"));
  const filePath = path.join(directory, "chat-store.json");
  try {
    await fs.writeFile(filePath, "{broken", "utf8");
    const repository = new ChatStoreRepository(filePath);
    await assert.rejects(() => repository.read(), (error: unknown) => error instanceof StateFileError && error.code === "STATE_FILE_INVALID_JSON");
    assert.equal(await fs.readFile(filePath, "utf8"), "{broken");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function awaitText(filePath: string) {
  // 测试辅助函数同步读取最终快照，确保标准解析器可直接消费。
  return fsSync.readFileSync(filePath, "utf8");
}
