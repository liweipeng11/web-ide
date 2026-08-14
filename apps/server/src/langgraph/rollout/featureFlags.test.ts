import assert from "node:assert/strict";
import test from "node:test";
import { readReadOnlyRuntimeRollout } from "./featureFlags.js";

test("只读 LangGraph 模式默认关闭并解析 shadow/internal", () => {
  assert.deepEqual(readReadOnlyRuntimeRollout({}), { mode: "off" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "shadow" }), { mode: "shadow" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: " INTERNAL " }), { mode: "internal" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "all" }), { mode: "off" });
});
