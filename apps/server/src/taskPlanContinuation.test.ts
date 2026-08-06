import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskPlanContinuationRequest, decideTaskPlanContinuation, MAX_AUTOMATIC_PLAN_CONTINUATIONS } from "./taskPlanContinuation.js";
import type { TaskPlanItem } from "./types.js";

const planItems: TaskPlanItem[] = [
  { id: "analyze", title: "分析项目", status: "completed", createdAt: 1, updatedAt: 1 },
  { id: "implement", title: "实现功能", status: "in_progress", note: "修改服务端", createdAt: 1, updatedAt: 1 },
  { id: "validate", title: "验证结果", status: "pending", createdAt: 1, updatedAt: 1 }
];

test("未完成且仍有计划步骤时自动续跑当前步骤", () => {
  const decision = decideTaskPlanContinuation({
    runtimeStatus: "incomplete",
    continuationCount: 0,
    hasPendingToolCall: false,
    generatedPatchCount: 0,
    planItems
  });

  assert.equal(decision.shouldContinue, true);
  assert.equal(decision.planItem?.id, "implement");
  assert.match(buildTaskPlanContinuationRequest("修复任务执行", decision.planItem!), /禁止重复宽泛搜索/);
});

test("审批、补丁、完成状态或超过上限时不能自动续跑", () => {
  for (const input of [
    { runtimeStatus: "awaiting_approval" as const, continuationCount: 0, hasPendingToolCall: true, generatedPatchCount: 0 },
    { runtimeStatus: "incomplete" as const, continuationCount: 0, hasPendingToolCall: false, generatedPatchCount: 1 },
    { runtimeStatus: "incomplete" as const, continuationCount: MAX_AUTOMATIC_PLAN_CONTINUATIONS, hasPendingToolCall: false, generatedPatchCount: 0 }
  ]) {
    assert.equal(decideTaskPlanContinuation({ ...input, planItems }).shouldContinue, false);
  }
});
