import assert from "node:assert/strict";
import test from "node:test";
import type { Plan, RuntimeTool } from "../../runtime/contracts.js";
import { MainAgent } from "./mainAgent.js";
import type { MainAgentDecisionModel } from "./mainAgentModel.js";
import { PlannerAgent } from "../planner/plannerAgent.js";
import type { PlannerAgentDecisionModel } from "../planner/plannerAgentModel.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import { MainAgentRuntime, type MainAgentRuntimeResult } from "./mainAgentRuntime.js";

class RuntimeDecisionModel implements MainAgentDecisionModel {
  routeCalls = 0;
  readonly actionInputs: string[] = [];

  constructor(
    private readonly routeValue: unknown,
    private readonly actions: unknown[]
  ) {}

  async route() {
    this.routeCalls += 1;
    return this.routeValue;
  }

  async nextAction(input: string) {
    this.actionInputs.push(input);
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

class ReplanRouteModel extends RuntimeDecisionModel {
  async shouldReplan() {
    return { shouldReplan: true, reason: "Redis Session 事实推翻 JWT 假设" };
  }
}

class SequencedPlannerModel implements PlannerAgentDecisionModel {
  readonly inputs: string[] = [];

  constructor(private readonly createValues: unknown[]) {}

  async createPlan(input: string) {
    this.inputs.push(input);
    if (!this.createValues.length) throw new Error("测试计划结果已耗尽");
    return this.createValues.shift();
  }

  async replan() {
    throw new Error("本测试不执行 replan");
  }
}

class SequencedReplanPlannerModel implements PlannerAgentDecisionModel {
  readonly inputs: string[] = [];

  constructor(private readonly values: unknown[]) {}

  async createPlan() {
    throw new Error("本测试不创建初始计划");
  }

  async replan(input: string) {
    this.inputs.push(input);
    if (!this.values.length) throw new Error("重规划测试结果已耗尽");
    return this.values.shift();
  }
}

function successfulExploration(): ExplorerExecution {
  const exploration = {
    summary: "当前认证使用 Redis Session",
    relevantFiles: ["src/session/redis.ts"],
    facts: [{ statement: "登录成功后写入 Redis Session", evidence: ["src/session/redis.ts:18"] }],
    unknowns: []
  };
  return {
    result: {
      taskId: "EXPLORE-CONTEXT-1",
      status: "success",
      summary: exploration.summary,
      facts: exploration.facts.map((fact) => fact.statement),
      changedFiles: [],
      evidence: exploration.facts.flatMap((fact) => fact.evidence),
      blockers: []
    },
    exploration,
    state: {
      goal: "重构认证系统",
      completedTasks: ["EXPLORE-CONTEXT-1"],
      failedTasks: [],
      changedFiles: [],
      facts: exploration.facts.map((fact) => fact.statement),
      status: "completed"
    }
  };
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

test("计划准备阶段将无依赖关系的 explore Task 按并发上限执行", async () => {
  const routeModel = new RuntimeDecisionModel(
    { intent: "analysis", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const planner = new PlannerAgent(new RuntimePlannerModel({
    status: "ready",
    plan: {
      assumptions: [],
      tasks: [
        { id: "E1", type: "explore", goal: "读取入口", dependencies: [], acceptanceCriteria: ["入口已确认"] },
        { id: "E2", type: "explore", goal: "读取配置", dependencies: [], acceptanceCriteria: ["配置已确认"] },
        { id: "I1", type: "implement", goal: "等待人工批准", dependencies: ["E1", "E2"], acceptanceCriteria: ["不在计划阶段执行"] }
      ],
      completionCriteria: ["探索完成"]
    }
  }));
  let active = 0;
  let maxActive = 0;
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner,
    explorationConcurrency: 2,
    explorer: {
      async executePlanTask(plan, taskId) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        const artifact = successfulExploration();
        return {
          ...artifact,
          result: { ...artifact.result, taskId },
          state: {
            ...artifact.state,
            plan: { ...plan, tasks: plan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : { ...task }) },
            status: "running"
          }
        };
      }
    }
  });

  const result = await runtime.planWithExploration({ goal: "分析认证系统", readScope: ["src/**"] });
  assert.equal(maxActive, 2);
  assert.equal(result.planning?.status, "ready");
  if (result.planning?.status !== "ready") return;
  assert.equal(result.planning.plan.tasks.find((task) => task.id === "E1")?.status, "completed");
  assert.equal(result.planning.plan.tasks.find((task) => task.id === "E2")?.status, "completed");
  assert.equal(result.planning.plan.tasks.find((task) => task.id === "I1")?.status, "pending");
});

test("direct 请求把入口已读代码作为事实交给 Main", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] },
    [{ type: "respond", content: "login 返回布尔值" }, { type: "finish" }]
  );
  const runtime = new MainAgentRuntime({ agent: new MainAgent(model) });
  const result = await runtime.execute({
    goal: "解释 login 函数",
    knownFacts: ["文件 src/auth.ts：export const login = () => true;"]
  });

  assertExecuted(result);
  assert.match(model.actionInputs[0], /src\/auth\.ts/);
  assert.match(model.actionInputs[0], /login = \(\) => true/);
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

test("Main 执行 Planner 指定的 explore Task 并只接收结构化探索结果", async () => {
  const plan: Plan = {
    version: 1,
    goal: "理解认证系统",
    assumptions: [],
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "定位认证流程",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["给出认证事实"],
      status: "pending"
    }],
    completionCriteria: ["认证流程已确认"]
  };
  let delegatedTaskId = "";
  const runtime = new MainAgentRuntime({
    explorer: {
      async executePlanTask(_plan, taskId) {
        delegatedTaskId = taskId;
        const execution = successfulExploration();
        return { ...execution, result: { ...execution.result, taskId } };
      }
    }
  });

  const result = await runtime.executeExploreTask(plan, "T1");
  assert.equal(delegatedTaskId, "T1");
  assert.deepEqual(result.exploration?.relevantFiles, ["src/session/redis.ts"]);
  assert.doesNotMatch(JSON.stringify(result.exploration), /完整文件正文/);
});

test("Planner missing_context 时 Main 调用 Explorer 补充事实后再次规划", async () => {
  const routeModel = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const plannerModel = new SequencedPlannerModel([
    { status: "missing_context", required: ["需要确认当前 Session 实现"] },
    {
      status: "ready",
      plan: {
        assumptions: [],
        tasks: [{ id: "T1", type: "implement", goal: "迁移认证", dependencies: [], acceptanceCriteria: ["迁移完成"] }],
        completionCriteria: ["认证迁移完成"]
      }
    }
  ]);
  let exploreCalls = 0;
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner: new PlannerAgent(plannerModel),
    explorer: {
      async executePlanTask() {
        exploreCalls += 1;
        return successfulExploration();
      }
    }
  });
  const result = await runtime.planWithExploration({
    goal: "重构认证系统",
    readScope: ["src/**"],
    writeScope: ["src/auth/**"]
  });

  assert.equal(exploreCalls, 1);
  assert.equal(result.planning?.status, "ready");
  assert.equal(result.explorations.length, 1);
  assert.match(plannerModel.inputs[1], /Redis Session/);
  assert.match(plannerModel.inputs[1], /src\/session\/redis\.ts:18/);
});

test("Planner missing_context 但没有 readScope 时 Main 不自动扩大 Explorer 权限", async () => {
  const routeModel = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  let exploreCalls = 0;
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner: new PlannerAgent(new RuntimePlannerModel({ status: "missing_context", required: ["需要仓库结构"] })),
    explorer: {
      async executePlanTask() {
        exploreCalls += 1;
        return successfulExploration();
      }
    }
  });
  const result = await runtime.planWithExploration({ goal: "重构认证系统" });

  assert.equal(exploreCalls, 0);
  assert.equal(result.planning?.status, "missing_context");
});

test("Planner ready 后 Main 自动执行可运行的 explore Task 并停在 implement 边界", async () => {
  const routeModel = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const planner = new PlannerAgent(new RuntimePlannerModel({
    status: "ready",
    plan: {
      assumptions: [],
      tasks: [
        { id: "T1", type: "explore", goal: "确认认证入口", dependencies: [], acceptanceCriteria: ["给出入口证据"] },
        { id: "T2", type: "explore", goal: "确认影响范围", dependencies: ["T1"], acceptanceCriteria: ["给出影响证据"] },
        { id: "T3", type: "implement", goal: "迁移认证", dependencies: ["T2"], acceptanceCriteria: ["完成迁移"] }
      ],
      completionCriteria: ["认证迁移完成"]
    }
  }));
  const executedTaskIds: string[] = [];
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner,
    explorer: {
      async executePlanTask(plan, taskId) {
        executedTaskIds.push(taskId);
        const nextPlan: Plan = {
          ...plan,
          tasks: plan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : { ...task })
        };
        const artifact = successfulExploration();
        return {
          ...artifact,
          result: { ...artifact.result, taskId },
          state: {
            ...artifact.state,
            plan: nextPlan,
            completedTasks: nextPlan.tasks.filter((task) => task.status === "completed").map((task) => task.id),
            status: "running"
          }
        };
      }
    }
  });

  const result = await runtime.planWithExploration({
    goal: "重构认证系统",
    readScope: ["src/**"],
    writeScope: ["src/auth/**"]
  });

  assert.deepEqual(executedTaskIds, ["T1", "T2"]);
  assert.equal(result.planning?.status, "ready");
  if (result.planning?.status !== "ready") return;
  assert.equal(result.planning.plan.tasks.find((task) => task.id === "T1")?.status, "completed");
  assert.equal(result.planning.plan.tasks.find((task) => task.id === "T2")?.status, "completed");
  assert.equal(result.planning.plan.tasks.find((task) => task.id === "T3")?.status, "pending");
  assert.equal(result.explorations.length, 2);
});

test("ready Plan 中的 Explorer 连续失败后重规划，非法新版计划不会伪装为 ready", async () => {
  const routeModel = new RuntimeDecisionModel(
    { intent: "analysis", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const readyValue = {
    status: "ready",
    plan: {
      assumptions: [],
      tasks: [{ id: "T1", type: "explore", goal: "确认认证入口", dependencies: [], acceptanceCriteria: ["给出证据"] }],
      completionCriteria: ["认证入口已确认"]
    }
  };
  const planner = new PlannerAgent(new RuntimePlannerModel(readyValue, {
    status: "ready",
    plan: { assumptions: [], tasks: [], completionCriteria: ["认证入口已确认"] }
  }));
  let attempts = 0;
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner,
    explorer: {
      async executePlanTask(plan) {
        attempts += 1;
        const failedPlan: Plan = {
          ...plan,
          tasks: plan.tasks.map((task) => task.id === "T1" ? { ...task, status: "failed" as const } : task)
        };
        return {
          result: {
            taskId: "T1",
            status: "failed",
            summary: "Explorer 执行失败",
            facts: [],
            changedFiles: [],
            evidence: [],
            blockers: ["模型不可用"]
          },
          state: {
            goal: "确认认证入口",
            plan: failedPlan,
            completedTasks: [],
            failedTasks: ["T1"],
            changedFiles: [],
            facts: [],
            status: "failed"
          }
        };
      }
    }
  });

  const result = await runtime.planWithExploration({ goal: "分析认证系统", readScope: ["src/**"] });
  assert.equal(result.planning?.status, "failed");
  if (result.planning?.status !== "failed") return;
  assert.equal(attempts, 3);
  assert.match(result.planning.blockers.join("；"), /至少需要一个任务/);
});

test("Main 显式调度 Plan 中依赖已完成的 implement Task", async () => {
  const plan: Plan = {
    version: 1,
    goal: "修改认证超时",
    assumptions: [],
    tasks: [
      {
        id: "T1",
        type: "explore",
        goal: "定位认证配置",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/auth/**"],
        writeScope: [],
        acceptanceCriteria: ["定位配置"],
        status: "completed"
      },
      {
        id: "T2",
        type: "implement",
        goal: "修改认证超时",
        dependencies: ["T1"],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth/**"],
        writeScope: ["src/auth/service.ts"],
        acceptanceCriteria: ["超时为 30 秒"],
        status: "pending"
      }
    ],
    completionCriteria: ["修改完成"]
  };
  const calls: Array<{ taskId: string; constraints: string[] | undefined }> = [];
  const runtime = new MainAgentRuntime({
    developer: {
      async executePlanTask(receivedPlan, taskId, options) {
        calls.push({ taskId, constraints: options?.constraints });
        const nextPlan: Plan = {
          ...receivedPlan,
          tasks: receivedPlan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : { ...task })
        };
        return {
          result: {
            taskId,
            status: "success",
            summary: "认证超时已修改",
            facts: ["超时为 30 秒"],
            changedFiles: ["src/auth/service.ts"],
            evidence: ["src/auth/service.ts:1"],
            blockers: []
          },
          implementation: {
            summary: "认证超时已修改",
            facts: ["超时为 30 秒"],
            evidence: ["src/auth/service.ts:1"]
          },
          checkpointIds: [],
          state: {
            goal: receivedPlan.goal,
            plan: nextPlan,
            completedTasks: ["T1", "T2"],
            failedTasks: [],
            changedFiles: ["src/auth/service.ts"],
            facts: ["超时为 30 秒"],
            status: "completed"
          }
        };
      }
    }
  });

  const execution = await runtime.executeDeveloperTask(plan, "T2", { constraints: ["不能新增依赖"] });

  assert.deepEqual(calls, [{ taskId: "T2", constraints: ["不能新增依赖"] }]);
  assert.equal(execution.result.status, "success");
  assert.deepEqual(execution.result.changedFiles, ["src/auth/service.ts"]);
});

test("Main 的计划初始化不会自动调用 Developer 写文件", async () => {
  const routeModel = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: ["planning", "editing"] },
    []
  );
  const planner = new PlannerAgent(new RuntimePlannerModel({
    status: "ready",
    plan: {
      assumptions: [],
      tasks: [{ id: "T1", type: "implement", goal: "修改认证超时", dependencies: [], acceptanceCriteria: ["超时为 30 秒"] }],
      completionCriteria: ["修改完成"]
    }
  }));
  let developerCalls = 0;
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner,
    developer: {
      async executePlanTask() {
        developerCalls += 1;
        throw new Error("计划阶段不应执行 Developer");
      }
    }
  });

  const result = await runtime.planWithExploration({
    goal: "修改认证超时",
    readScope: ["src/auth/**"],
    writeScope: ["src/auth/**"]
  });

  assert.equal(result.planning?.status, "ready");
  assert.equal(developerCalls, 0);
});

test("Main 显式调度依赖已完成的 test Task 且透传验证范围", async () => {
  const plan: Plan = {
    version: 1,
    goal: "修改并验证认证限流",
    assumptions: [],
    tasks: [
      {
        id: "T2",
        type: "implement",
        goal: "修改认证限流",
        dependencies: [],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth/**"],
        writeScope: ["src/auth/service.ts"],
        acceptanceCriteria: ["限流实现完成"],
        status: "completed"
      },
      {
        id: "T3",
        type: "test",
        goal: "验证认证限流",
        dependencies: ["T2"],
        requiredCapabilities: ["testing"],
        readScope: ["src/auth/**", "tests/auth/**", "package.json"],
        writeScope: [],
        acceptanceCriteria: ["第 6 次请求返回 429"],
        status: "pending"
      }
    ],
    completionCriteria: ["认证限流通过测试"]
  };
  const calls: Array<{ taskId: string; changedFiles: string[]; testScope: string[] }> = [];
  const runtime = new MainAgentRuntime({
    tester: {
      async executePlanTask(receivedPlan, taskId, options) {
        calls.push({ taskId, changedFiles: options.changedFiles, testScope: options.testScope });
        return {
          result: {
            taskId,
            status: "success",
            summary: "验证通过",
            facts: ["相关测试：tests/auth/rate-limit.test.ts"],
            changedFiles: [],
            evidence: ["pnpm test：passed"],
            blockers: []
          },
          validation: {
            status: "passed",
            checks: { test: [{ status: "passed", command: "pnpm test", exitCode: 0, issueCount: 0 }] },
            failures: [],
            acceptanceCriteria: [{ criterion: "第 6 次请求返回 429", status: "passed", evidence: ["pnpm test"] }],
            evidence: ["pnpm test：passed"],
            relatedTests: ["tests/auth/rate-limit.test.ts"]
          },
          state: {
            goal: receivedPlan.goal,
            plan: {
              ...receivedPlan,
              tasks: receivedPlan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : task)
            },
            completedTasks: ["T2", "T3"],
            failedTasks: [],
            changedFiles: [],
            facts: [],
            status: "completed"
          }
        };
      }
    }
  });

  const execution = await runtime.executeTestTask(plan, "T3", {
    changedFiles: ["src/auth/service.ts"],
    testScope: ["tests/auth/**"],
    acceptanceEvidence: [{ criterion: "第 6 次请求返回 429", testFiles: ["tests/auth/rate-limit.test.ts"] }]
  });

  assert.deepEqual(calls, [{ taskId: "T3", changedFiles: ["src/auth/service.ts"], testScope: ["tests/auth/**"] }]);
  assert.equal(execution.validation?.status, "passed");
  assert.deepEqual(execution.result.changedFiles, []);
});

test("Main 在用户总授权内扩展小范围 Developer Task", () => {
  const plan: Plan = {
    version: 1,
    goal: "增加登录限流",
    assumptions: [],
    tasks: [{
      id: "T2",
      type: "implement",
      goal: "实现登录限流",
      dependencies: [],
      requiredCapabilities: ["editing"],
      readScope: ["src/**"],
      writeScope: ["src/auth/service.ts"],
      acceptanceCriteria: ["第 6 次请求返回 429"],
      status: "blocked"
    }],
    completionCriteria: ["登录限流生效"]
  };
  const decision = new MainAgentRuntime().resolveDeveloperScopeChange(plan, "T2", {
    taskId: "T2",
    status: "blocked",
    summary: "需要共享中间件",
    facts: [],
    changedFiles: [],
    evidence: [],
    blockers: ["需要共享中间件"],
    scopeChangeRequest: {
      reason: "需要共享中间件",
      requiredScope: ["src/middleware/rate-limit.ts"]
    }
  }, { readScope: ["src/**"], writeScope: ["src/**"] });

  assert.equal(decision.action, "expand_task");
  if (decision.action !== "expand_task") return;
  assert.equal(decision.plan.version, 2);
  assert.equal(decision.plan.tasks[0].status, "pending");
  assert.deepEqual(decision.plan.tasks[0].readScope, ["src/**", "src/middleware/rate-limit.ts"]);
  assert.deepEqual(decision.plan.tasks[0].writeScope, ["src/auth/service.ts", "src/middleware/rate-limit.ts"]);
  assert.equal(plan.tasks[0].status, "blocked");
});

test("Main 不会自动扩展用户总授权之外的 Developer 范围", () => {
  const plan: Plan = {
    version: 1,
    goal: "修改认证服务",
    assumptions: [],
    tasks: [{
      id: "T2",
      type: "implement",
      goal: "修改认证服务",
      dependencies: [],
      requiredCapabilities: ["editing"],
      readScope: ["src/**"],
      writeScope: ["src/auth/**"],
      acceptanceCriteria: ["认证修改完成"],
      status: "blocked"
    }],
    completionCriteria: ["认证修改完成"]
  };
  const decision = new MainAgentRuntime().resolveDeveloperScopeChange(plan, "T2", {
    taskId: "T2",
    status: "blocked",
    summary: "需要支付服务",
    facts: [],
    changedFiles: [],
    evidence: [],
    blockers: ["需要支付服务"],
    scopeChangeRequest: {
      reason: "需要支付服务",
      requiredScope: ["src/payment/service.ts"]
    }
  }, { readScope: ["src/**"], writeScope: ["src/auth/**"] });

  assert.equal(decision.action, "replan");
  if (decision.action !== "replan") return;
  assert.match(decision.reason, /超出用户授权范围/);
});

test("计划准备阶段的 Explorer 推翻关键假设后立即重规划", async () => {
  const routeModel = new ReplanRouteModel(
    { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: [] },
    []
  );
  const plannerModel = new RuntimePlannerModel(
    {
      status: "ready",
      plan: {
        assumptions: ["认证使用 JWT"],
        tasks: [
          { id: "T1", type: "explore", goal: "确认认证机制", dependencies: [], acceptanceCriteria: ["确认认证机制"] },
          { id: "T2", type: "implement", goal: "迁移认证", dependencies: ["T1"], acceptanceCriteria: ["迁移完成"] }
        ],
        completionCriteria: ["认证迁移完成"]
      }
    },
    {
      status: "ready",
      plan: {
        assumptions: [],
        tasks: [
          { id: "T1", type: "explore", goal: "确认认证机制", dependencies: [], acceptanceCriteria: ["确认认证机制"] },
          { id: "T3", type: "implement", goal: "基于 Redis Session 调整认证", dependencies: ["T1"], acceptanceCriteria: ["迁移完成"] }
        ],
        completionCriteria: ["认证迁移完成"]
      }
    }
  );
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(routeModel),
    planner: new PlannerAgent(plannerModel),
    explorer: {
      async executePlanTask(plan, taskId) {
        const exploration = successfulExploration();
        const nextPlan: Plan = {
          ...plan,
          tasks: plan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : task)
        };
        return {
          ...exploration,
          result: { ...exploration.result, taskId },
          state: {
            ...exploration.state,
            goal: plan.goal,
            plan: nextPlan,
            completedTasks: [taskId],
            status: "running" as const
          }
        };
      }
    }
  });

  const planning = await runtime.planWithExploration({
    goal: "迁移认证系统",
    readScope: ["src/**"],
    writeScope: ["src/auth/**"]
  });

  assert.equal(planning.planning?.status, "ready");
  if (planning.planning?.status !== "ready") return;
  assert.equal(planning.planning.plan.version, 2);
  assert.equal(planning.planning.plan.tasks.find((task) => task.id === "T1")?.status, "completed");
  assert.equal(planning.replans?.[0]?.status, "ready");
});

test("Replan 缺少上下文时调用 Explorer，并保留约束再次规划", async () => {
  const oldPlan: Plan = {
    version: 1,
    goal: "迁移认证系统",
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
      status: "completed"
    }],
    completionCriteria: ["迁移方案符合真实认证机制"]
  };
  const plannerModel = new SequencedReplanPlannerModel([
    { status: "missing_context", required: ["确认 Session 存储位置"] },
    {
      status: "ready",
      plan: {
        assumptions: [],
        tasks: [
          { id: "T1", type: "explore", goal: "确认认证机制", dependencies: [], acceptanceCriteria: ["确认认证机制"] },
          { id: "T2", type: "implement", goal: "迁移 Session", dependencies: ["T1"], acceptanceCriteria: ["迁移完成"] }
        ],
        completionCriteria: ["迁移方案符合真实认证机制"]
      }
    }
  ]);
  let explorerCalls = 0;
  const runtime = new MainAgentRuntime({
    planner: new PlannerAgent(plannerModel),
    explorer: {
      async executePlanTask(_plan, taskId) {
        explorerCalls += 1;
        const exploration = successfulExploration();
        return { ...exploration, result: { ...exploration.result, taskId } };
      }
    }
  });

  const result = await runtime.replanWithExploration({
    oldPlan,
    completedTasks: ["T1"],
    newFacts: [],
    constraints: ["不新增第三方依赖"],
    readScope: ["src/**"],
    writeScope: ["src/auth/**"]
  });

  assert.equal(result.planning.status, "ready");
  assert.equal(explorerCalls, 1);
  assert.equal(result.explorations.length, 1);
  assert.match(plannerModel.inputs[1], /不新增第三方依赖/);
  assert.match(plannerModel.inputs[1], /Redis Session/);
});
