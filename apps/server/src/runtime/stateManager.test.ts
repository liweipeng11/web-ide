import assert from "node:assert/strict";
import test from "node:test";
import type { Plan } from "./contracts.js";
import { createAgentState, StateManager, validatePlan } from "./stateManager.js";

function createPlan(): Plan {
  return {
    version: 1,
    goal: "完成 Runtime 基线",
    assumptions: [],
    completionCriteria: ["所有任务完成"],
    tasks: [
      {
        id: "T1",
        type: "explore",
        goal: "确认现状",
        dependencies: [],
        requiredCapabilities: ["read"],
        readScope: ["src/**"],
        writeScope: [],
        acceptanceCriteria: ["输出事实"],
        status: "pending"
      },
      {
        id: "T2",
        type: "implement",
        goal: "实现功能",
        dependencies: ["T1"],
        requiredCapabilities: ["edit"],
        readScope: ["src/**"],
        writeScope: ["src/runtime/**"],
        acceptanceCriteria: ["测试通过"],
        status: "pending"
      }
    ]
  };
}

test("StateManager 完成任务并去重收集事实和变更文件", () => {
  const manager = new StateManager(createAgentState("完成 Runtime 基线", createPlan()));
  manager.startTask("T1");
  manager.applyResult({
    taskId: "T1",
    status: "success",
    summary: "探索完成",
    facts: ["使用 TypeScript", "使用 TypeScript"],
    changedFiles: ["src/runtime/contracts.ts", "src/runtime/contracts.ts"],
    evidence: ["package.json"],
    blockers: []
  });

  const state = manager.getState();
  assert.deepEqual(state.completedTasks, ["T1"]);
  assert.deepEqual(state.facts, ["使用 TypeScript"]);
  assert.deepEqual(state.changedFiles, ["src/runtime/contracts.ts"]);
  assert.equal(state.plan?.tasks[0].status, "completed");
  assert.equal(state.status, "running");
});

test("StateManager 在依赖未完成时拒绝启动任务", () => {
  const manager = new StateManager(createAgentState("完成 Runtime 基线", createPlan()));
  assert.throws(
    () => manager.startTask("T2"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "TASK_DEPENDENCY_NOT_SATISFIED"
  );
});

test("validatePlan 拒绝循环依赖", () => {
  const plan = createPlan();
  plan.tasks[0].dependencies = ["T2"];
  assert.throws(
    () => validatePlan(plan),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_CONTRACT"
  );
});

test("validatePlan 拒绝缺少完成标准的计划和任务", () => {
  const planWithoutCompletionCriteria = createPlan();
  planWithoutCompletionCriteria.completionCriteria = [];
  assert.throws(() => validatePlan(planWithoutCompletionCriteria), /completionCriteria/);

  const planWithoutAcceptanceCriteria = createPlan();
  planWithoutAcceptanceCriteria.tasks[0].acceptanceCriteria = [];
  assert.throws(() => validatePlan(planWithoutAcceptanceCriteria), /验收标准/);
});

test("blocked 结果让 Runtime 等待上层决策", () => {
  const manager = new StateManager(createAgentState("完成 Runtime 基线", createPlan()));
  manager.startTask("T1");
  manager.applyResult({
    taskId: "T1",
    status: "blocked",
    summary: "需要扩大范围",
    facts: [],
    changedFiles: [],
    evidence: [],
    blockers: ["缺少文件权限"],
    scopeChangeRequest: { reason: "需要读取配置", requiredScope: ["config/**"] }
  });

  assert.equal(manager.getState().status, "waiting_user");
  assert.equal(manager.getTask("T1").status, "blocked");
});
