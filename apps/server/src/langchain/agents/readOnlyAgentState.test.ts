import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceReadOnlyAgentState,
  createReadOnlyAgentState,
  failReadOnlyAgentState,
  finishReadOnlyAgentState
} from "./readOnlyAgentState.js";

test("只读 Agent 状态按不可变方式记录并去重事实与工具调用", () => {
  const initial = createReadOnlyAgentState(" 分析认证模块 ", { maxSteps: 3, maxToolCalls: 2, maxReadFiles: 2 });
  const first = advanceReadOnlyAgentState(initial, {
    toolCall: { id: "call-1", name: "read_file" },
    readFiles: 1,
    facts: ["入口在 auth.ts", "入口在 auth.ts"],
    evidence: ["src/auth.ts:1"]
  });
  const second = advanceReadOnlyAgentState(first, {
    toolCall: { id: "call-1", name: "read_file" },
    facts: ["使用 Session"]
  });

  assert.equal(initial.stepCount, 0);
  assert.equal(second.stepCount, 2);
  assert.equal(second.toolCallCount, 2);
  assert.equal(second.toolCalls.length, 1);
  assert.deepEqual(second.facts, ["入口在 auth.ts", "使用 Session"]);
  assert.equal(finishReadOnlyAgentState(second, "分析完成").status, "completed");
});

test("只读 Agent 状态强制步骤、工具和读取预算", () => {
  const stepLimited = createReadOnlyAgentState("分析", { maxSteps: 1 });
  assert.throws(() => advanceReadOnlyAgentState(advanceReadOnlyAgentState(stepLimited)), /最大步骤数/);

  const toolLimited = createReadOnlyAgentState("分析", { maxToolCalls: 1 });
  const afterTool = advanceReadOnlyAgentState(toolLimited, { toolCall: { id: "1", name: "grep" } });
  assert.throws(() => advanceReadOnlyAgentState(afterTool, { toolCall: { id: "2", name: "grep" } }), /最大工具调用数/);

  const readLimited = createReadOnlyAgentState("分析", { maxReadFiles: 1 });
  assert.throws(() => advanceReadOnlyAgentState(readLimited, { readFiles: 2 }), /最大读取文件数/);
});

test("只读 Agent 终态不可继续推进", () => {
  const initial = createReadOnlyAgentState("分析");
  const failed = failReadOnlyAgentState(initial, "cancelled", "用户取消");
  assert.equal(failed.status, "cancelled");
  assert.throws(() => advanceReadOnlyAgentState(failed), /已处于终态/);
  assert.throws(() => createReadOnlyAgentState(" "), /目标不能为空/);
});
