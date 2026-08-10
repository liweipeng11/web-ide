import assert from "node:assert/strict";
import test from "node:test";
import type { Plan, RuntimeTool } from "../../runtime/contracts.js";
import { MainAgent } from "./mainAgent.js";
import type { MainAgentDecisionModel } from "./mainAgentModel.js";
import { PlannerAgent } from "../planner/plannerAgent.js";
import type { PlannerAgentDecisionModel } from "../planner/plannerAgentModel.js";
import { MainAgentRuntime, type MainAgentRuntimeResult } from "./mainAgentRuntime.js";

class RuntimeDecisionModel implements MainAgentDecisionModel {
  routeCalls = 0;

  constructor(
    private readonly routeValue: unknown,
    private readonly actions: unknown[]
  ) {}

  async route() {
    this.routeCalls += 1;
    return this.routeValue;
  }

  async nextAction() {
    return this.actions.shift();
  }
}

class RuntimePlannerModel implements PlannerAgentDecisionModel {
  constructor(
    private readonly createValue: unknown,
    private readonly replanValue: unknown = createValue
  ) {}

  async createPlan() {
    return this.createValue;
  }

  async replan() {
    return this.replanValue;
  }
}

function assertExecuted(result: MainAgentRuntimeResult): asserts result is Extract<MainAgentRuntimeResult, { outcome: "executed" }> {
  assert.equal(result.outcome, "executed");
}

test("正式入口只执行一次路由并完成 direct 请求", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] },
    [{ type: "respond", content: "直接回答" }, { type: "finish" }]
  );
  const runtime = new MainAgentRuntime({ agent: new MainAgent(model) });
  const result = await runtime.execute({ goal: "解释这个函数" });

  assertExecuted(result);
  assert.equal(model.routeCalls, 1);
  assert.equal(result.decision.route, "direct");
  assert.equal(result.execution.result.status, "success");
  assert.equal(result.execution.result.summary, "直接回答");
});

test("正式入口从写工具结果同步 changedFiles 到 Result 和 State", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "medium", route: "main_loop", requiredCapabilities: ["read", "edit"] },
    [
      { type: "tool", tool: "edit_file", args: { filePath: "src/auth.ts" } },
      { type: "respond", content: "已修改超时时间。" },
      { type: "finish" }
    ]
  );
  const editTool: RuntimeTool = {
    name: "edit_file",
    description: "编辑文件",
    effect: "write",
    getTargetPaths: (args) => [String(args.filePath)],
    getChangedFiles: (args) => [String(args.filePath)],
    async execute() {
      return { changed: true };
    }
  };
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(model),
    tools: [editTool],
    allowedTools: ["edit_file"]
  });
  const result = await runtime.execute({
    goal: "修改 auth.ts 中的超时时间",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    allowedTools: ["edit_file"],
    acceptanceCriteria: ["auth.ts 已更新"]
  });

  assertExecuted(result);
  assert.deepEqual(result.execution.result.changedFiles, ["src/auth.ts"]);
  assert.deepEqual(result.execution.state.changedFiles, ["src/auth.ts"]);
  assert.match(result.execution.state.facts[0], /受控写入/);
});

test("只读意图会在正式入口移除写工具和 writeScope", async () => {
  let executionCount = 0;
  const model = new RuntimeDecisionModel(
    { intent: "analysis", complexity: "medium", route: "main_loop", requiredCapabilities: ["read"] },
    [{ type: "tool", tool: "edit_file", args: { filePath: "src/auth.ts" } }]
  );
  const editTool: RuntimeTool = {
    name: "edit_file",
    description: "编辑文件",
    effect: "write",
    getTargetPaths: (args) => [String(args.filePath)],
    getChangedFiles: (args) => [String(args.filePath)],
    async execute() {
      executionCount += 1;
      return { changed: true };
    }
  };
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(model),
    tools: [editTool],
    allowedTools: ["edit_file"]
  });
  const result = await runtime.execute({
    goal: "只分析 auth.ts，不要修改",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    allowedTools: ["edit_file"]
  });

  assertExecuted(result);
  assert.equal(executionCount, 0);
  assert.equal(result.execution.result.status, "failed");
  assert.deepEqual(result.execution.state.changedFiles, []);
  assert.match(result.execution.result.blockers[0], /不能调用任务未授权的工具/);
});

test("代码修改没有 Runtime 确认的变更文件时不能完成", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "medium", route: "main_loop", requiredCapabilities: ["read", "edit"] },
    [
      { type: "tool", tool: "read_file", args: { filePath: "src/auth.ts" } },
      { type: "respond", content: "已修改。" },
      { type: "finish" }
    ]
  );
  const readTool: RuntimeTool = {
    name: "read_file",
    description: "读取文件",
    effect: "read",
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      return "content";
    }
  };
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(model),
    tools: [readTool],
    allowedTools: ["read_file"]
  });
  const result = await runtime.execute({
    goal: "修改 auth.ts",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    allowedTools: ["read_file"]
  });

  assertExecuted(result);
  assert.equal(result.execution.result.status, "failed");
  assert.match(result.execution.result.blockers[0], /没有经过 Runtime 确认的变更文件/);
});

test("main_loop 未执行工具时不能只靠文字响应完成", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "analysis", complexity: "medium", route: "main_loop", requiredCapabilities: ["read"] },
    [{ type: "respond", content: "分析完成。" }, { type: "finish" }]
  );
  const runtime = new MainAgentRuntime({ agent: new MainAgent(model) });
  const result = await runtime.execute({ goal: "分析 auth.ts" });

  assertExecuted(result);
  assert.equal(result.execution.result.status, "failed");
  assert.match(result.execution.result.blockers[0], /尚未执行任何受控工具/);
});

test("正式入口将 planned 请求交给 Planner 并把 Plan 返回 Main", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const planner = new PlannerAgent(new RuntimePlannerModel({
    status: "ready",
    plan: {
      assumptions: [],
      tasks: [
        { id: "T1", type: "explore", goal: "确认认证现状", dependencies: [], acceptanceCriteria: ["输出认证事实"] },
        { id: "T2", type: "implement", goal: "迁移认证实现", dependencies: ["T1"], acceptanceCriteria: ["实现兼容迁移"] },
        { id: "T3", type: "test", goal: "验证认证流程", dependencies: ["T2"], acceptanceCriteria: ["认证测试通过"] }
      ],
      completionCriteria: ["迁移完成且验证通过"]
    }
  }));
  const runtime = new MainAgentRuntime({ agent: new MainAgent(model), planner });
  const result = await runtime.execute({
    goal: "重构整个认证系统",
    readScope: ["src/**"],
    writeScope: ["src/auth/**"]
  });

  assert.equal(result.outcome, "planning");
  if (result.outcome !== "planning") return;
  assert.equal(result.planning.status, "ready");
  if (result.planning.status !== "ready") return;
  assert.equal(result.planning.plan.version, 1);
  assert.deepEqual(result.planning.plan.tasks[0].writeScope, []);
  assert.deepEqual(result.planning.plan.tasks[1].writeScope, ["src/auth/**"]);
});

test("Planner 缺少上下文时正式入口返回结构化需求而不伪造执行", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const planner = new PlannerAgent(new RuntimePlannerModel({
    status: "missing_context",
    required: ["需要了解当前认证模块结构"]
  }));
  const result = await new MainAgentRuntime({ agent: new MainAgent(model), planner }).execute({
    goal: "重构整个认证系统"
  });

  assert.equal(result.outcome, "planning");
  if (result.outcome !== "planning") return;
  assert.deepEqual(result.planning, {
    status: "missing_context",
    required: ["需要了解当前认证模块结构"]
  });
});

test("Main 的 replan 入口保留已完成进度并接收新版 Plan", async () => {
  const oldPlan: Plan = {
    version: 1,
    goal: "迁移认证系统",
    assumptions: [],
    completionCriteria: ["迁移完成"],
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "确认认证现状",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["输出认证事实"],
      status: "completed"
    }]
  };
  const planner = new PlannerAgent(new RuntimePlannerModel({}, {
    status: "ready",
    plan: {
      assumptions: [],
      tasks: [{ id: "T2", type: "implement", goal: "实现 JWT", dependencies: ["T1"], acceptanceCriteria: ["完成实现"] }],
      completionCriteria: ["迁移完成"]
    }
  }));
  const runtime = new MainAgentRuntime({ planner });
  const result = await runtime.replan({ oldPlan, completedTasks: ["T1"], newFacts: ["当前使用 Session"] });

  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.plan.version, 2);
  assert.equal(result.plan.tasks.find((task) => task.id === "T1")?.status, "completed");
});
