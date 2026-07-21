import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMemoryV3Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { applyMemoryLifecycle } from "./memoryLifecycleService.js";

const NOW = 1_800_000_000_000;

test("手工架构事实过期只标记 stale，自动事实长期未使用会归档", () => {
  const base = createProjectMemoryV3Fixture();
  const template = base.items[0]!;
  const memory = createProjectMemoryV3Fixture({ items: [
    { ...template, id: "manual", kind: "decision", status: "active", createdBy: "user", expiresAt: NOW - 1, validationStatus: "valid" },
    { ...template, id: "automatic", status: "active", createdBy: "system", updatedAt: NOW - 200 * 86_400_000, validationStatus: "valid" }
  ] });
  const result = applyMemoryLifecycle(memory, { now: NOW });
  assert.equal(result.items.find((item) => item.id === "manual")?.status, "stale");
  assert.equal(result.items.find((item) => item.id === "automatic")?.status, "archived");
});

test("完成目标会关闭，最近改动同时按时间和数量清理", () => {
  const base = createProjectMemoryV3Fixture();
  const changes = Array.from({ length: 30 }, (_, index) => ({ taskSessionId: `task-${index}`, summary: `change-${index}`, files: [], changedAt: NOW - index * 86_400_000 }));
  const memory = { ...base, snapshot: { ...base.snapshot, currentGoals: ["已完成", "继续处理"], recentChanges: changes } };
  const result = applyMemoryLifecycle(memory, { now: NOW, completedTaskSummaries: new Set(["已完成"]) });
  assert.deepEqual(result.snapshot.currentGoals, ["继续处理"]);
  assert.equal(result.snapshot.recentChanges.length, 20);
  assert.ok(result.snapshot.recentChanges.every((change) => NOW - change.changedAt <= 90 * 86_400_000));
});
