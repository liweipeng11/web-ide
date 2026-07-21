import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMemoryV3Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { findSupersededMemoryIds, supersedeConflictingMemories } from "./memoryConflictService.js";

test("更新且相反的新事实替代旧事实，并保留替代链", () => {
  const base = createProjectMemoryV3Fixture();
  const template = base.items[0]!;
  const oldItem = { ...template, id: "old", kind: "decision" as const, content: "必须使用 npm", status: "active" as const, updatedAt: 100 };
  const replacement = { ...template, id: "new", kind: "decision" as const, content: "禁止使用 npm", status: "active" as const, updatedAt: 200 };
  assert.deepEqual(findSupersededMemoryIds([oldItem, replacement], replacement), ["old"]);
  const result = supersedeConflictingMemories(createProjectMemoryV3Fixture({ items: [oldItem, replacement] }), "new", 300);
  const superseded = result.items.find((item) => item.id === "old");
  assert.equal(superseded?.status, "superseded");
  assert.equal(superseded?.validationStatus, "superseded");
  assert.equal(superseded?.supersededBy, "new");
});

test("不同作用域或更旧的新项不会错误替代", () => {
  const base = createProjectMemoryV3Fixture();
  const template = base.items[0]!;
  const oldItem = { ...template, id: "old", kind: "decision" as const, content: "必须使用 npm", status: "active" as const, updatedAt: 200 };
  const otherScope = { ...template, id: "new", kind: "decision" as const, content: "禁止使用 npm", status: "active" as const, scope: { type: "path" as const, paths: ["apps/web"] }, updatedAt: 100 };
  assert.deepEqual(findSupersededMemoryIds([oldItem, otherScope], otherScope), []);
});
