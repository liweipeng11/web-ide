import assert from "node:assert/strict";
import test from "node:test";
import { readReadOnlyRuntimeRollout, readWriteRuntimeRollout } from "./featureFlags.js";

test("只读 LangGraph 模式默认关闭并解析完整灰度配置", () => {
  assert.deepEqual(readReadOnlyRuntimeRollout({}), { mode: "off" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "shadow" }), { mode: "shadow" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: " INTERNAL " }), { mode: "internal" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "10" }), { mode: "10" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "50" }), { mode: "50" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "ALL" }), { mode: "all" });
  assert.deepEqual(readReadOnlyRuntimeRollout({ AGENT_LANGGRAPH_READ_ONLY_MODE: "25" }), { mode: "off" });
});

test("写任务细分灰度保持总开关兼容且非法值安全关闭", () => {
  assert.deepEqual(readWriteRuntimeRollout({}), { mode: "all" });
  assert.deepEqual(readWriteRuntimeRollout({ AGENT_LANGGRAPH_WRITE_MODE: "10" }), { mode: "10" });
  assert.deepEqual(readWriteRuntimeRollout({ AGENT_LANGGRAPH_WRITE_MODE: "shadow" }), { mode: "shadow" });
  assert.deepEqual(readWriteRuntimeRollout({ AGENT_LANGGRAPH_WRITE_MODE: "invalid" }), { mode: "off" });
});
