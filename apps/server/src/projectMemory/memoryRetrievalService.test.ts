import assert from "node:assert/strict";
import test from "node:test";
import { createProjectMemoryV3Fixture } from "./fixtures/projectMemoryV2.fixture.js";
import { normalizeMemoryRetrievalContext, retrieveProjectMemory } from "./memoryRetrievalService.js";

test("统一召回服务按相关性、最大条数与实际预算返回可追踪结果", () => {
  const base = createProjectMemoryV3Fixture();
  const memory = createProjectMemoryV3Fixture({
    items: [
      { ...base.items[0]!, id: "auth-decision", kind: "decision", status: "active", content: "JWT authentication architecture", updatedAt: base.updatedAt - 1_000 },
      { ...base.items[0]!, id: "auth-risk", kind: "risk", status: "active", content: "authentication token leakage risk", updatedAt: base.updatedAt - 2_000 },
      { ...base.items[0]!, id: "ui-fact", kind: "fact", status: "active", content: "UI spacing changed", updatedAt: base.updatedAt }
    ]
  });
  const input = { userRequest: "review authentication", maxItems: 1, tokenBudget: 500 };
  const first = retrieveProjectMemory(memory, input, base.updatedAt);
  const second = retrieveProjectMemory(memory, input, base.updatedAt);

  assert.equal(first.selectedItems.length, 1);
  assert.equal(first.selectedItems[0]?.item.id, "auth-risk");
  assert.ok(first.selectedItems[0]?.score);
  assert.ok(first.selectedItems[0]?.reasons.length);
  assert.doesNotMatch(first.prompt, /UI spacing/);
  assert.ok(first.estimatedTokens <= first.tokenBudget);
  assert.deepEqual(second, first);
});

test("统一上下文规范化会去重、限制边界并保留调用方线索", () => {
  const context = normalizeMemoryRetrievalContext({
    userRequest: "  auth  ",
    contextPaths: ["src/auth.ts", "src/auth.ts"],
    plannedFiles: ["src/session.ts"],
    maxItems: 999,
    tokenBudget: 99_999
  });

  assert.equal(context.userRequest, "auth");
  assert.deepEqual(context.contextPaths, ["src/auth.ts"]);
  assert.equal(context.maxItems, 50);
  assert.equal(context.tokenBudget, 8_000);
});
