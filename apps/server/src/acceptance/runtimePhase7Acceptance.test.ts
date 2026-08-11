import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, Plan, RouteDecision } from "../runtime/contracts.js";
import { createAgentState, StateManager } from "../runtime/stateManager.js";
import { MainAgentOrchestrator, type MainOrchestrationRuntimeFacade } from "../agents/main/mainAgentOrchestrator.js";

function apply(plan: Plan, result: AgentResult) {
  const state = createAgentState(plan.goal, plan);
  state.completedTasks = plan.tasks.filter((task) => task.status === "completed").map((task) => task.id);
  const manager = new StateManager(state);
  manager.startTask(result.taskId);
  manager.applyResult(result);
  return manager.getState();
}

test("阶段 7：关键假设失效后保留已完成任务并执行新版 DAG", async () => {
  const initialPlan: Plan = {
    version: 1,
    goal: "根据真实认证机制生成迁移说明",
    assumptions: ["认证使用 JWT"],
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "确认认证机制",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["确认认证机制"],
      status: "pending"
    }],
    completionCriteria: ["输出基于真实认证机制的结论"]
  };
  const revisedPlan: Plan = {
    version: 2,
    goal: initialPlan.goal,
    assumptions: [],
    tasks: [
      { ...initialPlan.tasks[0], status: "completed" },
      {
        id: "T2",
        type: "respond",
        goal: "说明系统实际使用 Redis Session",
        dependencies: ["T1"],
        requiredCapabilities: ["respond"],
        readScope: [],
        writeScope: [],
        acceptanceCriteria: ["结论与仓库事实一致"],
        status: "pending"
      }
    ],
    completionCriteria: ["输出基于真实认证机制的结论"]
  };
  const calls: string[] = [];
  const runtime: MainOrchestrationRuntimeFacade = {
    async executeDecision() { throw new Error("验收不执行 direct"); },
    async planWithExploration() { throw new Error("验收直接执行给定计划"); },
    async executeExploreTask(plan, taskId) {
      calls.push("explorer");
      const result: AgentResult = {
        taskId,
        status: "success",
        summary: "已确认认证机制",
        facts: ["认证实际使用 Redis Session"],
        changedFiles: [],
        evidence: ["src/session.ts:1"],
        blockers: []
      };
      return {
        result,
        exploration: {
          summary: result.summary,
          relevantFiles: ["src/session.ts"],
          facts: [{ statement: result.facts[0], evidence: result.evidence }],
          unknowns: []
        },
        state: apply(plan, result)
      };
    },
    async executeDeveloperTask() { throw new Error("验收不执行 Developer"); },
    async executeTestTask() { throw new Error("验收不执行 Tester"); },
    async summarize() { return "系统实际使用 Redis Session。"; },
    async shouldReplan() {
      return { shouldReplan: true, reason: "Redis Session 事实推翻 JWT 假设。", source: "semantic" };
    },
    async replanWithExploration(request) {
      calls.push("planner:replan");
      assert.deepEqual(request.completedTasks, ["T1"]);
      assert.deepEqual(request.newFacts, ["认证实际使用 Redis Session"]);
      return { planning: { status: "ready", plan: revisedPlan }, explorations: [] };
    },
    resolveDeveloperScopeChange() { throw new Error("验收没有范围申请"); }
  };
  const decision: RouteDecision = {
    intent: "analysis",
    complexity: "complex",
    route: "planned",
    requiredCapabilities: ["planning", "exploration"]
  };

  const orchestration = await new MainAgentOrchestrator(runtime).executePlan(decision, initialPlan);

  assert.equal(orchestration.status, "completed");
  assert.equal(orchestration.plan?.version, 2);
  assert.deepEqual(orchestration.plan?.tasks.map((task) => task.status), ["completed", "completed"]);
  assert.deepEqual(calls, ["explorer", "planner:replan"]);
  assert.equal(orchestration.trace.events.some((event) => event.action === "replan"), true);
});
