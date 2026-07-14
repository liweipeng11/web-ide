import test from "node:test";
import assert from "node:assert/strict";
import { alignTaskPlanToWorkflow, reconcileRewrittenTaskPlanWorkflowIds } from "../taskPlanService.js";
import type { TaskPlanItem } from "../types.js";
import { buildTaskWorkflowRuntimePrompt, classifyTaskWorkflow, createTaskWorkflow, getTaskWorkflowSteps, resolvePlanModeTaskStatus } from "./index.js";

test("selects bugfix workflow for diagnose-then-edit tasks", () => {
  const result = classifyTaskWorkflow("修复登录接口报错", {
    intent: "diagnose_then_edit",
    confidence: 0.92,
    normalizedGoal: "修复登录接口报错",
    reason: "test"
  });

  assert.equal(result.type, "bugfix");
  assert.equal(result.source, "intent");
});

test("prefers explicit refactor wording over generic edit intent", () => {
  const result = classifyTaskWorkflow("重构任务存储但不改变行为", {
    intent: "edit",
    confidence: 0.8,
    normalizedGoal: "重构任务存储但不改变行为",
    reason: "test"
  });

  assert.equal(result.type, "refactor");
});

test("uses analysis-only workflow for inspect tasks even when goal mentions refactor", () => {
  const result = classifyTaskWorkflow("分析这个模块应该如何重构", {
    intent: "inspect",
    confidence: 0.88,
    normalizedGoal: "分析这个模块应该如何重构",
    reason: "test"
  });

  assert.equal(result.type, "analysis-only");
});

test("creates feature workflow snapshots with independent template steps", () => {
  const workflow = createTaskWorkflow("新增任务工作流引擎", {
    intent: "edit",
    confidence: 0.9,
    normalizedGoal: "新增任务工作流引擎",
    reason: "test"
  });
  const freshSteps = getTaskWorkflowSteps("feature");

  workflow.steps[0].title = "已修改";

  assert.equal(workflow.type, "feature");
  assert.equal(freshSteps[0].title, "分析项目与需求");
  assert.equal(workflow.steps.length, 6);
});

test("aligns AI plan output to stable workflow phases", () => {
  const workflow = createTaskWorkflow("新增导出功能", {
    intent: "edit",
    confidence: 0.9,
    normalizedGoal: "新增导出功能",
    reason: "test"
  });
  const aligned = alignTaskPlanToWorkflow([{ title: "任意模型标题", note: "模型补充说明" }], workflow, "新增导出功能");

  assert.equal(aligned.length, workflow.steps.length);
  assert.equal(aligned[0].workflowStepId, "analyze-project");
  assert.equal(aligned[0].title, "分析项目与需求");
  assert.equal(aligned[0].note, "模型补充说明");
  assert.equal(aligned[5].workflowStepId, "summarize");
});

test("builds runtime instructions from the persisted workflow snapshot", () => {
  const workflow = createTaskWorkflow("分析模块依赖", {
    intent: "inspect",
    confidence: 0.9,
    normalizedGoal: "分析模块依赖",
    reason: "test"
  });
  const prompt = buildTaskWorkflowRuntimePrompt(workflow);

  assert.match(prompt, /Task workflow: analysis-only/);
  assert.match(prompt, /1\. 明确分析问题/);
  assert.match(prompt, /Do not generate or apply patches/);
});

test("restores valid workflow ids after AI plan rewrites", () => {
  const now = Date.now();
  const currentItems: TaskPlanItem[] = [
    { id: "1", workflowStepId: "analyze-project", title: "分析项目与需求", status: "completed", createdAt: now, updatedAt: now },
    { id: "2", workflowStepId: "implement", title: "实现聚焦变更", status: "in_progress", createdAt: now, updatedAt: now }
  ];
  const rewritten = reconcileRewrittenTaskPlanWorkflowIds(currentItems, [
    { workflowStepId: "forged", title: "实现聚焦变更" },
    { title: "重新分析项目" }
  ]);

  assert.deepEqual(rewritten.map((item) => item.workflowStepId), ["implement", "analyze-project"]);
});

test("resolves Plan mode completion without claiming edit workflows succeeded", () => {
  assert.equal(resolvePlanModeTaskStatus("feature", "completed"), "paused");
  assert.equal(resolvePlanModeTaskStatus("refactor", "completed"), "paused");
  assert.equal(resolvePlanModeTaskStatus("analysis-only", "completed"), "success");
  assert.equal(resolvePlanModeTaskStatus(undefined, "step_limit_reached"), "failed");
});
