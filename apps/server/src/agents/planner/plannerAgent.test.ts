import assert from "node:assert/strict";
import test from "node:test";
import type { Plan } from "../../runtime/contracts.js";
import { createAgentState, validatePlan } from "../../runtime/stateManager.js";
import { PlannerAgent } from "./plannerAgent.js";
import type { PlannerAgentDecisionModel } from "./plannerAgentModel.js";

class FakePlannerModel implements PlannerAgentDecisionModel {
  constructor(
    private readonly createValue: unknown,
    private readonly replanValue: unknown = createValue
  ) {}

  async createPlan() {
    if (this.createValue instanceof Error) throw this.createValue;
    return this.createValue;
  }

  async replan() {
    if (this.replanValue instanceof Error) throw this.replanValue;
    return this.replanValue;
  }
}

function readyPlan(tasks: unknown[]) {
  return {
    status: "ready",
    plan: {
      assumptions: [],
      tasks,
      completionCriteria: ["所有计划任务均满足验收条件"]
    }
  };
}

function oldPlan(): Plan {
  return {
    version: 1,
    goal: "迁移认证系统",
    assumptions: [],
    completionCriteria: ["认证迁移完成"],
    tasks: [
      {
        id: "T1",
        type: "explore",
        goal: "确认认证现状",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/**"],
        writeScope: [],
        acceptanceCriteria: ["输出认证事实"],
        status: "completed"
      },
      {
        id: "T2",
        type: "implement",
        goal: "迁移认证实现",
        dependencies: ["T1"],
        requiredCapabilities: ["editing"],
        readScope: ["src/**"],
        writeScope: ["src/auth/**"],
        acceptanceCriteria: ["完成兼容迁移"],
        status: "pending"
      }
    ]
  };
}

test("createPlan 生成由 Runtime 安全字段补全的 DAG", async () => {
  const planner = new PlannerAgent(new FakePlannerModel(readyPlan([
    { id: "T1", type: "explore", goal: "确认认证现状", dependencies: [], acceptanceCriteria: ["输出认证事实"] },
    { id: "T2", type: "implement", goal: "实现 JWT", dependencies: ["T1"], acceptanceCriteria: ["登录返回 JWT"] },
    { id: "T3", type: "test", goal: "验证认证流程", dependencies: ["T2"], acceptanceCriteria: ["认证测试通过"] }
  ])));
  const state = createAgentState("迁移认证系统");
  const result = await planner.createPlan({
    goal: "迁移认证系统",
    knownFacts: ["当前使用 Session"],
    constraints: ["保持 API 兼容"],
    readScope: ["src/**"],
    writeScope: ["src/auth/**"],
    state
  });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.doesNotThrow(() => validatePlan(result.plan));
  assert.deepEqual(result.plan.tasks.map((task) => task.requiredCapabilities), [
    ["exploration"], ["editing"], ["testing"]
  ]);
  assert.deepEqual(result.plan.tasks.map((task) => task.writeScope), [[], ["src/auth/**"], []]);
});

test("createPlan 拒绝循环依赖和不存在的依赖", async () => {
  const cyclic = new PlannerAgent(new FakePlannerModel(readyPlan([
    { id: "T1", type: "explore", goal: "探索", dependencies: ["T2"], acceptanceCriteria: ["有结论"] },
    { id: "T2", type: "implement", goal: "实现", dependencies: ["T1"], acceptanceCriteria: ["已实现"] }
  ])));
  const cyclicResult = await cyclic.createPlan({
    goal: "复杂任务", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("复杂任务")
  });
  assert.equal(cyclicResult.status, "failed");
  if (cyclicResult.status === "failed") {
    assert.equal(cyclicResult.reason, "invalid_plan");
    assert.match(cyclicResult.blockers[0], /循环依赖/);
  }

  const missingDependency = new PlannerAgent(new FakePlannerModel(readyPlan([
    { id: "T1", type: "test", goal: "验证", dependencies: ["UNKNOWN"], acceptanceCriteria: ["验证通过"] }
  ])));
  const missingDependencyResult = await missingDependency.createPlan({
    goal: "复杂任务", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: [], state: createAgentState("复杂任务")
  });
  assert.equal(missingDependencyResult.status, "failed");
  if (missingDependencyResult.status === "failed") assert.match(missingDependencyResult.blockers[0], /不存在的依赖/);
});

test("信息不足时返回 missing_context 而不是猜测计划", async () => {
  const planner = new PlannerAgent(new FakePlannerModel({
    status: "missing_context",
    required: ["需要了解当前认证模块结构"]
  }));
  const result = await planner.createPlan({
    goal: "迁移认证系统",
    knownFacts: [],
    constraints: [],
    readScope: ["src/**"],
    writeScope: ["src/**"],
    state: createAgentState("迁移认证系统")
  });

  assert.deepEqual(result, {
    status: "missing_context",
    required: ["需要了解当前认证模块结构"]
  });
});

test("replan 增加版本并恢复模型遗漏或篡改的已完成任务", async () => {
  const previous = oldPlan();
  const planner = new PlannerAgent(new FakePlannerModel({}, readyPlan([
    { id: "T1", type: "implement", goal: "篡改后的目标", dependencies: [], acceptanceCriteria: ["篡改后的标准"] },
    { id: "T2", type: "implement", goal: "基于 Redis Session 迁移", dependencies: ["T1"], acceptanceCriteria: ["完成兼容迁移"] },
    { id: "T3", type: "test", goal: "验证认证流程", dependencies: ["T2"], acceptanceCriteria: ["认证测试通过"] }
  ])));
  const state = createAgentState(previous.goal, previous);
  state.completedTasks = ["T1"];
  state.facts = ["项目使用 Redis Session"];
  const result = await planner.replan({
    oldPlan: previous,
    completedTasks: ["T1"],
    newFacts: ["项目使用 Redis Session"],
    constraints: ["保持 API 兼容"],
    readScope: ["src/**"],
    writeScope: ["src/auth/**"],
    state
  });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.plan.version, 2);
  const completedTask = result.plan.tasks.find((task) => task.id === "T1");
  assert.equal(completedTask?.status, "completed");
  assert.equal(completedTask?.goal, "确认认证现状");
  assert.deepEqual(completedTask?.acceptanceCriteria, ["输出认证事实"]);
  assert.doesNotThrow(() => validatePlan(result.plan));
});

test("replan 会把模型遗漏的已完成任务补回新计划", async () => {
  const previous = oldPlan();
  const planner = new PlannerAgent(new FakePlannerModel({}, readyPlan([
    { id: "T2", type: "implement", goal: "继续迁移认证", dependencies: ["T1"], acceptanceCriteria: ["完成兼容迁移"] }
  ])));
  const result = await planner.replan({
    oldPlan: previous,
    completedTasks: ["T1"],
    newFacts: ["项目使用 Redis Session"],
    constraints: [],
    readScope: ["src/**"],
    writeScope: ["src/auth/**"],
    state: createAgentState(previous.goal, previous)
  });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.plan.tasks.find((task) => task.id === "T1")?.status, "completed");
  assert.doesNotThrow(() => validatePlan(result.plan));
});

test("replan 拒绝旧计划中不存在的已完成任务", async () => {
  const previous = oldPlan();
  const planner = new PlannerAgent(new FakePlannerModel({}, readyPlan([
    { id: "T2", type: "implement", goal: "迁移认证", dependencies: [], acceptanceCriteria: ["完成迁移"] }
  ])));
  const result = await planner.replan({
    oldPlan: previous,
    completedTasks: ["UNKNOWN"],
    newFacts: [],
    constraints: [],
    readScope: ["src/**"],
    writeScope: ["src/auth/**"],
    state: createAgentState(previous.goal, previous)
  });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.blockers[0], /不存在的任务/);
});

test("Planner 拒绝超过硬性上限的任务图", async () => {
  const tasks = Array.from({ length: 31 }, (_value, index) => ({
    id: `T${index + 1}`,
    type: "explore",
    goal: `任务 ${index + 1}`,
    dependencies: [],
    acceptanceCriteria: ["完成"]
  }));
  const planner = new PlannerAgent(new FakePlannerModel(readyPlan(tasks)));
  const result = await planner.createPlan({
    goal: "超大计划",
    knownFacts: [],
    constraints: [],
    readScope: ["src/**"],
    writeScope: [],
    state: createAgentState("超大计划")
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.blockers[0], /数量上限 30/);
});

test("Provider 异常转换为不泄露内部信息的统一失败结果", async () => {
  const planner = new PlannerAgent(new FakePlannerModel(new Error("secret-provider-token")));
  const result = await planner.createPlan({
    goal: "复杂任务",
    knownFacts: [],
    constraints: [],
    readScope: ["src/**"],
    writeScope: [],
    state: createAgentState("复杂任务")
  });

  assert.deepEqual(result, {
    status: "failed",
    reason: "model_error",
    blockers: ["Planner 模型调用失败，请稍后重试。"]
  });
});
