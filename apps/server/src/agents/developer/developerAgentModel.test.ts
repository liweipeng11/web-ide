import assert from "node:assert/strict";
import test from "node:test";
import { hasActionType } from "./developerAgentModel.js";

test("Developer action 必须包含字符串 type 字段", () => {
  assert.equal(hasActionType({ summary: "仅有分析结论" }), false);
  assert.equal(hasActionType({ type: "tool", tool: "read_file" }), true);
  assert.equal(hasActionType(["tool"]), false);
});
