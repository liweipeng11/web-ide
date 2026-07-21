import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createProjectMemoryTestWorkspace, createProjectMemoryV2Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { migrateProjectMemory } from "./projectMemoryMigration.js";
import { readProjectMemory } from "./projectMemoryStore.js";

test("V2 数据无损迁移到 V3，旧 conventions 降级为候选 Memory", () => {
  const legacy = createProjectMemoryV2Fixture({ conventions: ["使用 pnpm", "使用 pnpm", "新增中文注释"] });
  const migrated = migrateProjectMemory(legacy);

  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.snapshot.projectSummary, legacy.projectSummary);
  assert.deepEqual(migrated.snapshot.techStack, legacy.techStack);
  assert.deepEqual(migrated.snapshot.currentGoals, legacy.currentGoals);
  assert.deepEqual(migrated.snapshot.recentChanges, legacy.recentChanges);
  assert.deepEqual(migrated.snapshot.pendingItems, legacy.pendingItems);
  assert.deepEqual(migrated.snapshot.confirmedRisks, legacy.confirmedRisks);
  assert.deepEqual(migrated.items.map((item) => item.content), ["使用 pnpm", "新增中文注释"]);
  assert.ok(migrated.items.every((item) => item.status === "candidate" && item.createdBy === "migration"));
  assert.ok(migrated.items.every((item) => item.sourceRefs[0]?.value === "project-memory-v2:conventions"));
});

test("V1 无来源字段时保留全部事实并保护原时间", () => {
  const { projectSummarySource: _source, ...v2 } = createProjectMemoryV2Fixture();
  const migrated = migrateProjectMemory({ ...v2, schemaVersion: 1 });

  assert.equal(migrated.snapshot.projectSummarySource, "manual");
  assert.equal(migrated.createdAt, v2.createdAt);
  assert.equal(migrated.updatedAt, v2.updatedAt);
  assert.deepEqual(migrated.snapshot.confirmedRisks, v2.confirmedRisks);
  assert.ok(migrated.items.every((item) => item.sourceRefs[0]?.value === "project-memory-v1:conventions"));
});

test("V3 规范化会按内容、类型和作用域去重", () => {
  const base = migrateProjectMemory(createProjectMemoryV2Fixture({ conventions: ["使用 pnpm"] }));
  const duplicate = { ...base.items[0]!, id: "newer", updatedAt: base.updatedAt + 1 };
  const normalized = migrateProjectMemory({ ...base, items: [...base.items, duplicate] });

  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.items[0]?.id, "newer");
});

test("未知 Schema 迁移失败时不会覆盖磁盘原文件", async (context) => {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const memoryPath = path.join(workspaceRoot, ".mini-ai", "state", "runtime", "project-memory.json");
  const raw = JSON.stringify({ schemaVersion: 99, futureData: true });
  await fs.mkdir(path.dirname(memoryPath), { recursive: true });
  await fs.writeFile(memoryPath, raw, "utf8");

  await assert.rejects(() => readProjectMemory(workspaceRoot), /Unsupported project memory schema version/);
  assert.equal(await fs.readFile(memoryPath, "utf8"), raw);
});
