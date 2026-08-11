import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, Plan, RouteDecision } from "../../runtime/contracts.js";
import { createAgentState, StateManager } from "../../runtime/stateManager.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import type { DeveloperExecution } from "../developer/developerAgentRuntime.js";
import type { TesterExecution } from "../tester/testerAgentRuntime.js";
import { MainAgentOrchestrator, type MainOrchestrationRuntimeFacade } from "./mainAgentOrchestrator.js";
import { evaluateReplanRules, type ReplanPolicyInput } from "./replanPolicy.js";

function decision(route: RouteDecision["route"]): RouteDecision {
  return {
    intent: route === "direct" ? "question" : "code_change",
    complexity: route === "direct" ? "simple" : route === "main_loop" ? "medium" : "complex",
    route,
    requiredCapabilities: route === "planned"
      ? ["planning", "exploration", "editing", "testing"]
      : route === "main_loop" ? ["read", "edit"] : []
  };
}

function result(taskId: string, status: AgentResult["status"], changedFiles: string[] = []): AgentResult {
  return {
    taskId,
    status,
    summary: `${taskId}:${status}`,
    facts: [],
    changedFiles,
    evidence: [`evidence:${taskId}`],
    blockers: status === "success" ? [] : [`blocker:${taskId}`]
  };
}

function apply(plan: Plan, taskId: string, agentResult: AgentResult) {
  const state = createAgentState(plan.goal, plan);
  state.completedTasks = plan.tasks.filter((task) => task.status === "completed").map((task) => task.id);
  const manager = new StateManager(state);
  manager.startTask(taskId);
  manager.applyResult(agentResult);
  return manager.getState();
}

function complexPlan(): Plan {
  const acceptanceCriteria = ["超过限制时返回 429"];
  return {
    version: 1,
    goal: "为登录接口增加限流并测试",
    assumptions: [],
    tasks: [
      {
        id: "T1",
        type: "explore",
        goal: "定位登录流程",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/**", "tests/**"],
        writeScope: [],
        acceptanceCriteria: ["定位登录实现和测试"],
        status: "pending"
      },
      {
        id: "T2",
        type: "implement",
        goal: "实现登录限流",
        dependencies: ["T1"],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth.ts"],
        writeScope: ["src/auth.ts"],
        acceptanceCriteria,
        status: "pending"
      },
      {
        id: "T3",
        type: "test",
        goal: "验证登录限流",
        dependencies: ["T2"],
        requiredCapabilities: ["testing"],
        readScope: ["src/auth.ts", "tests/auth.test.ts"],
        writeScope: [],
        acceptanceCriteria,
        status: "pending"
      }
    ],
    completionCriteria: acceptanceCriteria
  };
}

class FakeRuntime implements MainOrchestrationRuntimeFacade {
  readonly calls: string[] = [];
  private developerAttempts = 0;

  constructor(
    private readonly route: RouteDecision["route"],
    private readonly developerStatus: AgentResult["status"] = "success",
    private readonly replannedPlan?: Plan,
    private readonly invalidateAssumption = false,
    private readonly scopeMode: "none" | "small" | "large" | "unauthorized" = "none",
    private readonly failedChangedFiles = false
  ) {}

  async executeDecision() {
    this.calls.push("main:execute");
    const directResult = result("MAIN-1", "success");
    return {
      outcome: "executed" as const,
      decision: decision("direct"),
      execution: { result: directResult, state: createAgentState("解释 login") }
    };
  }

  async planWithExploration() {
    this.calls.push("main:route");
    if (this.route !== "planned") {
      return { decision: decision(this.route), planning: null, explorations: [] };
    }
    return {
      decision: decision("planned"),
      planning: { status: "ready" as const, plan: complexPlan() },
      explorations: []
    };
  }

  async executeExploreTask(plan: Plan, taskId: string): Promise<ExplorerExecution> {
    this.calls.push("explorer");
    const explorerResult = result(taskId, "success");
    if (this.invalidateAssumption) explorerResult.facts = ["认证实际使用 Redis Session"];
    return {
      result: explorerResult,
      exploration: {
        summary: "已定位登录流程",
        relevantFiles: ["src/auth.ts", "tests/auth.test.ts"],
        facts: [{ statement: "login 位于 src/auth.ts", evidence: ["src/auth.ts:1"] }],
        unknowns: []
      },
      state: apply(plan, taskId, explorerResult)
    };
  }

  async executeDeveloperTask(plan: Plan, taskId: string): Promise<DeveloperExecution> {
    this.calls.push("developer");
    this.developerAttempts += 1;
    const requestsScope = this.scopeMode !== "none" && this.developerAttempts === 1;
    const status = requestsScope ? "blocked" : this.developerStatus;
    const developerResult = result(
      taskId,
      status,
      status === "success" || (status === "failed" && this.failedChangedFiles) ? ["src/auth.ts"] : []
    );
    if (requestsScope) {
      developerResult.scopeChangeRequest = {
        reason: "实现需要调整共享认证模块",
        requiredScope: ["src/shared-auth.ts"]
      };
    }
    return {
      result: developerResult,
      implementation: status === "success"
        ? { summary: "已实现", facts: [], evidence: ["src/auth.ts"] }
        : undefined,
      checkpointIds: status === "success" ? ["checkpoint-1"] : [],
      state: apply(plan, taskId, developerResult)
    };
  }

  async executeTestTask(plan: Plan, taskId: string): Promise<TesterExecution> {
    this.calls.push("tester");
    const testerResult = result(taskId, "success");
    return {
      result: testerResult,
      validation: {
        status: "passed",
        checks: {},
        failures: [],
        acceptanceCriteria: [{ criterion: "超过限制时返回 429", status: "passed", evidence: ["tests/auth.test.ts"] }],
        evidence: ["pnpm test"],
        relatedTests: ["tests/auth.test.ts"]
      },
      state: apply(plan, taskId, testerResult)
    };
  }

  async summarize(input: { results: AgentResult[] }) {
    this.calls.push("main:summarize");
    return input.results.map((item) => item.summary).join("\n") || "计划已完成。";
  }

  async shouldReplan(input: ReplanPolicyInput) {
    const rule = evaluateReplanRules(input);
    if (rule.shouldReplan !== null) return rule;
    const invalidated = input.plan.assumptions.length > 0 && input.result.facts.length > 0;
    return {
      shouldReplan: invalidated,
      reason: invalidated ? "认证实现事实推翻了 JWT 假设。" : "没有结构性变化。",
      source: "semantic" as const
    };
  }

  async replanWithExploration() {
    this.calls.push("planner:replan");
    if (!this.replannedPlan) {
      return {
        planning: { status: "failed" as const, reason: "invalid_plan" as const, blockers: ["测试未配置新版计划"] },
        explorations: []
      };
    }
    return { planning: { status: "ready" as const, plan: this.replannedPlan }, explorations: [] };
  }

  resolveDeveloperScopeChange(plan: Plan, taskId: string) {
    if (this.scopeMode === "none") throw new Error("当前测试未配置 Developer 范围变化。");
    if (this.scopeMode === "small") {
      return {
        action: "expand_task" as const,
        addedScope: ["src/shared-auth.ts"],
        plan: {
          ...plan,
          version: plan.version + 1,
          tasks: plan.tasks.map((task) => task.id === taskId
            ? {
                ...task,
                readScope: [...task.readScope, "src/shared-auth.ts"],
                writeScope: [...task.writeScope, "src/shared-auth.ts"],
                status: "pending" as const
              }
            : task)
        }
      };
    }
    return {
      action: "replan" as const,
      reason: this.scopeMode === "unauthorized" ? "所需路径超出用户授权范围。" : "范围变化较大，需要重新规划。",
      requiredScope: ["src/shared-auth.ts"],
      requiresAuthorization: this.scopeMode === "unauthorized"
    };
  }
}

test("simple 请求绕过 Planner 和所有专业 Agent", async () => {
  const runtime = new FakeRuntime("direct");
  const orchestration = await new MainAgentOrchestrator(runtime).run({ goal: "解释 login 函数" });

  assert.equal(orchestration.status, "completed");
  assert.deepEqual(orchestration.trace.calledAgents, ["main"]);
  assert.deepEqual(runtime.calls, ["main:route", "main:execute"]);
});

test("同一依赖层的 Explorer 受限并发且结果合并到唯一 Plan", async () => {
  const plan: Plan = {
    version: 1,
    goal: "并行确认前后端事实",
    assumptions: [],
    tasks: [
      { id: "E1", type: "explore", goal: "确认服务端", dependencies: [], requiredCapabilities: ["exploration"], readScope: ["apps/server/**"], writeScope: [], acceptanceCriteria: ["返回服务端事实"], status: "pending" },
      { id: "E2", type: "explore", goal: "确认前端", dependencies: [], requiredCapabilities: ["exploration"], readScope: ["apps/web/**"], writeScope: [], acceptanceCriteria: ["返回前端事实"], status: "pending" },
      { id: "R1", type: "respond", goal: "汇总事实", dependencies: ["E1", "E2"], requiredCapabilities: ["respond"], readScope: [], writeScope: [], acceptanceCriteria: ["完成汇总"], status: "pending" }
    ],
    completionCriteria: ["完成汇总"]
  };
  const runtime = new FakeRuntime("planned");
  let active = 0;
  let maxActive = 0;
  runtime.executeExploreTask = async (currentPlan, taskId) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    const explorerResult = result(taskId, "success");
    return {
      result: explorerResult,
      exploration: { summary: taskId, relevantFiles: [], facts: [], unknowns: [] },
      state: apply(currentPlan, taskId, explorerResult),
      diagnostics: { attempts: 1, retries: 0, startedAt: 1, finishedAt: 16, durationMs: 15, timeoutMs: 60_000, failureCategory: "none", retryable: false }
    };
  };

  const orchestration = await new MainAgentOrchestrator(runtime, 30, 3, 2).executePlan(decision("planned"), plan);

  assert.equal(orchestration.status, "completed");
  assert.equal(maxActive, 2);
  assert.deepEqual(orchestration.plan?.tasks.map((task) => task.status), ["completed", "completed", "completed"]);
  const groups = orchestration.trace.events.filter((event) => event.agent === "explorer").map((event) => event.concurrencyGroup);
  assert.equal(groups.length, 2);
  assert.equal(groups[0], groups[1]);
});

test("编排在启动下一任务前响应用户取消", async () => {
  const controller = new AbortController();
  controller.abort();
  const runtime = new FakeRuntime("planned");
  const orchestration = await new MainAgentOrchestrator(runtime).executePlan(decision("planned"), complexPlan(), {
    signal: controller.signal
  });

  assert.equal(orchestration.status, "cancelled");
  assert.equal(runtime.calls.length, 0);
  assert.equal(orchestration.trace.events.at(-1)?.failureCategory, "cancelled");
});

test("medium 请求不调用 Planner，按 Main → Developer → Tester 执行", async () => {
  const runtime = new FakeRuntime("main_loop");
  const orchestration = await new MainAgentOrchestrator(runtime).run({
    goal: "修改登录函数并跑测试",
    readScope: ["src/auth.ts", "tests/auth.test.ts"],
    writeScope: ["src/auth.ts"],
    testScope: ["tests/auth.test.ts"],
    acceptanceCriteria: ["超过限制时返回 429"]
  });

  assert.equal(orchestration.status, "completed");
  assert.deepEqual(orchestration.trace.calledAgents, ["main", "developer", "tester"]);
  assert.equal(orchestration.trace.calledAgents.includes("planner"), false);
  assert.deepEqual(orchestration.changedFiles, ["src/auth.ts"]);
});

test("complex 请求按 DAG 串联五个 Agent", async () => {
  const runtime = new FakeRuntime("planned");
  const orchestration = await new MainAgentOrchestrator(runtime).run({
    goal: "为登录接口增加限流并增加测试",
    acceptanceEvidence: [{ criterion: "超过限制时返回 429", testFiles: ["tests/auth.test.ts"] }]
  });

  assert.equal(orchestration.status, "completed");
  assert.deepEqual(orchestration.trace.calledAgents, ["main", "planner", "explorer", "developer", "tester"]);
  assert.deepEqual(orchestration.plan?.tasks.map((task) => task.status), ["completed", "completed", "completed"]);
  assert.deepEqual(runtime.calls, ["main:route", "explorer", "developer", "tester", "main:summarize"]);
});

test("Developer 连续失败三次后请求重规划，Planner 失败时安全停止", async () => {
  const runtime = new FakeRuntime("planned", "failed");
  const orchestration = await new MainAgentOrchestrator(runtime).run({ goal: "为登录接口增加限流并增加测试" });

  assert.equal(orchestration.status, "blocked");
  assert.deepEqual(orchestration.trace.calledAgents, ["main", "planner", "explorer", "developer"]);
  assert.equal(runtime.calls.filter((call) => call === "developer").length, 3);
  assert.equal(runtime.calls.includes("planner:replan"), true);
  assert.equal(runtime.calls.includes("tester"), false);
});

test("Developer 失败前已有真实写入时不自动重试", async () => {
  const runtime = new FakeRuntime("planned", "failed", undefined, false, "none", true);
  const orchestration = await new MainAgentOrchestrator(runtime).run({ goal: "为登录接口增加限流并增加测试" });

  assert.equal(orchestration.status, "failed");
  assert.equal(runtime.calls.filter((call) => call === "developer").length, 1);
  assert.equal(runtime.calls.includes("planner:replan"), false);
  assert.deepEqual(orchestration.changedFiles, ["src/auth.ts"]);
});

test("依赖不满足或没有可运行任务时返回 blocked", async () => {
  const runtime = new FakeRuntime("planned");
  const plan = complexPlan();
  plan.tasks[0].status = "blocked";
  const orchestration = await new MainAgentOrchestrator(runtime).executePlan(decision("planned"), plan);

  assert.equal(orchestration.status, "blocked");
  assert.deepEqual(orchestration.trace.calledAgents, ["main"]);
});

test("关键假设被 Explorer 事实推翻后自动重规划并继续执行", async () => {
  const initialPlan = complexPlan();
  initialPlan.assumptions = ["认证使用 JWT"];
  const nextPlan = complexPlan();
  nextPlan.version = 2;
  nextPlan.assumptions = [];
  nextPlan.tasks[0].status = "completed";
  const runtime = new FakeRuntime("planned", "success", nextPlan, true);

  const orchestration = await new MainAgentOrchestrator(runtime).executePlan(decision("planned"), initialPlan, {
    acceptanceEvidence: [{ criterion: "超过限制时返回 429", testFiles: ["tests/auth.test.ts"] }]
  });

  assert.equal(orchestration.status, "completed");
  assert.equal(orchestration.plan?.version, 2);
  assert.equal(orchestration.trace.events.some((event) => event.action === "replan"), true);
  assert.deepEqual(runtime.calls, ["explorer", "planner:replan", "developer", "tester", "main:summarize"]);
});

test("Developer 的小范围授权内变化只扩展当前任务而不调用 Planner", async () => {
  const runtime = new FakeRuntime("main_loop", "success", undefined, false, "small");
  const orchestration = await new MainAgentOrchestrator(runtime).run({
    goal: "修改登录函数并跑测试",
    readScope: ["src/**", "tests/**"],
    writeScope: ["src/**"],
    testScope: ["tests/auth.test.ts"],
    acceptanceCriteria: ["超过限制时返回 429"]
  });

  assert.equal(orchestration.status, "completed");
  assert.equal(runtime.calls.filter((call) => call === "developer").length, 2);
  assert.equal(runtime.calls.includes("planner:replan"), false);
});

test("Developer 请求越过用户授权时停止且不调用 Planner", async () => {
  const runtime = new FakeRuntime("main_loop", "success", undefined, false, "unauthorized");
  const orchestration = await new MainAgentOrchestrator(runtime).run({
    goal: "修改登录函数并跑测试",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    acceptanceCriteria: ["超过限制时返回 429"]
  });

  assert.equal(orchestration.status, "blocked");
  assert.match(orchestration.summary, /超出用户授权范围/);
  assert.equal(runtime.calls.includes("planner:replan"), false);
});

test("Developer 的大范围授权内变化调用 Planner 后继续新版计划", async () => {
  const nextPlan = complexPlan();
  nextPlan.version = 2;
  nextPlan.tasks = nextPlan.tasks.slice(1);
  nextPlan.tasks[0] = {
    ...nextPlan.tasks[0],
    id: "IMPLEMENT-1",
    dependencies: [],
    readScope: ["src/**"],
    writeScope: ["src/**"],
    status: "pending"
  };
  nextPlan.tasks[1] = {
    ...nextPlan.tasks[1],
    id: "TEST-1",
    dependencies: ["IMPLEMENT-1"],
    status: "pending"
  };
  const runtime = new FakeRuntime("main_loop", "success", nextPlan, false, "large");
  const orchestration = await new MainAgentOrchestrator(runtime).run({
    goal: "修改登录函数并跑测试",
    readScope: ["src/**", "tests/**"],
    writeScope: ["src/**"],
    testScope: ["tests/auth.test.ts"],
    acceptanceCriteria: ["超过限制时返回 429"]
  });

  assert.equal(orchestration.status, "completed");
  assert.equal(runtime.calls.includes("planner:replan"), true);
  assert.equal(runtime.calls.filter((call) => call === "developer").length, 2);
});

test("连续重规划达到上限后安全停止", async () => {
  const loopPlan = complexPlan();
  loopPlan.assumptions = ["认证使用 JWT"];
  loopPlan.tasks = [loopPlan.tasks[0]];
  loopPlan.completionCriteria = ["确认认证机制"];
  const runtime = new FakeRuntime("planned", "success", loopPlan, true);
  const orchestration = await new MainAgentOrchestrator(runtime, 30, 2)
    .executePlan(decision("planned"), loopPlan);

  assert.equal(orchestration.status, "blocked");
  assert.match(orchestration.summary, /重规划次数已达到上限 2/);
  assert.equal(runtime.calls.filter((call) => call === "planner:replan").length, 2);
});
