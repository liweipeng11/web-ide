import assert from "node:assert/strict";
import test from "node:test";
import type { AgentResult, Plan, RouteDecision } from "../../runtime/contracts.js";
import { createAgentState, StateManager } from "../../runtime/stateManager.js";
import type { ExplorerExecution } from "../explorer/explorerAgentRuntime.js";
import type { DeveloperExecution } from "../developer/developerAgentRuntime.js";
import type { TesterExecution } from "../tester/testerAgentRuntime.js";
import { MainAgentOrchestrator, type MainOrchestrationRuntimeFacade } from "./mainAgentOrchestrator.js";

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

  constructor(
    private readonly route: RouteDecision["route"],
    private readonly developerStatus: AgentResult["status"] = "success"
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
    const developerResult = result(taskId, this.developerStatus, this.developerStatus === "success" ? ["src/auth.ts"] : []);
    return {
      result: developerResult,
      implementation: this.developerStatus === "success"
        ? { summary: "已实现", facts: [], evidence: ["src/auth.ts"] }
        : undefined,
      checkpointIds: this.developerStatus === "success" ? ["checkpoint-1"] : [],
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
}

test("simple 请求绕过 Planner 和所有专业 Agent", async () => {
  const runtime = new FakeRuntime("direct");
  const orchestration = await new MainAgentOrchestrator(runtime).run({ goal: "解释 login 函数" });

  assert.equal(orchestration.status, "completed");
  assert.deepEqual(orchestration.trace.calledAgents, ["main"]);
  assert.deepEqual(runtime.calls, ["main:route", "main:execute"]);
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

test("Developer 失败后安全停止且不会调用 Tester", async () => {
  const runtime = new FakeRuntime("planned", "failed");
  const orchestration = await new MainAgentOrchestrator(runtime).run({ goal: "为登录接口增加限流并增加测试" });

  assert.equal(orchestration.status, "failed");
  assert.deepEqual(orchestration.trace.calledAgents, ["main", "planner", "explorer", "developer"]);
  assert.equal(runtime.calls.includes("tester"), false);
});

test("依赖不满足或没有可运行任务时返回 blocked", async () => {
  const runtime = new FakeRuntime("planned");
  const plan = complexPlan();
  plan.tasks[0].status = "blocked";
  const orchestration = await new MainAgentOrchestrator(runtime).executePlan(decision("planned"), plan);

  assert.equal(orchestration.status, "blocked");
  assert.deepEqual(orchestration.trace.calledAgents, ["main"]);
});
