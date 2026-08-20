import assert from "node:assert/strict";
import test from "node:test";
import type { ExplorerExecution } from "../../agents/explorer/explorerAgentRuntime.js";
import type { PlannerResult } from "../../agents/planner/contracts.js";
import type { Plan, RouteDecision } from "../../runtime/contracts.js";
import { runPlanningGraph, type PlanningGraphRuntime } from "./planningGraph.js";

const plannedDecision: RouteDecision = {
  intent: "analysis",
  complexity: "complex",
  route: "planned",
  requiredCapabilities: ["planning", "exploration"]
};

function planWithExplorers(taskIds: string[]): Plan {
  return {
    version: 1,
    goal: "分析项目",
    assumptions: [],
    tasks: [
      ...taskIds.map((id) => ({
        id,
        type: "explore" as const,
        goal: `探索 ${id}`,
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/**"],
        writeScope: [],
        acceptanceCriteria: [`${id} 有证据`],
        status: "pending" as const
      })),
      {
        id: "I1",
        type: "implement",
        goal: "等待后续执行",
        dependencies: [...taskIds],
        requiredCapabilities: ["editing"],
        readScope: ["src/**"],
        writeScope: ["src/**"],
        acceptanceCriteria: ["实现完成"],
        status: "pending"
      }
    ],
    completionCriteria: ["分析完成"]
  };
}

function exploration(plan: Plan, taskId: string, status: "success" | "failed" = "success"): ExplorerExecution {
  const nextPlan: Plan = {
    ...plan,
    tasks: plan.tasks.map((task) => task.id === taskId
      ? { ...task, status: status === "success" ? "completed" as const : "failed" as const }
      : task)
  };
  return {
    result: {
      taskId,
      status,
      summary: status === "success" ? `${taskId} 完成` : `${taskId} 失败`,
      facts: status === "success" ? [`事实 ${taskId}`] : [],
      changedFiles: [],
      evidence: status === "success" ? [`src/${taskId}.ts:1`] : [],
      blockers: status === "failed" ? ["模型不可用"] : []
    },
    ...(status === "success" ? {
      exploration: {
        summary: `${taskId} 完成`,
        relevantFiles: [`src/${taskId}.ts`],
        facts: [{ statement: `事实 ${taskId}`, evidence: [`src/${taskId}.ts:1`] }],
        unknowns: []
      }
    } : {}),
    state: {
      goal: plan.goal,
      plan: nextPlan,
      completedTasks: status === "success" ? [taskId] : [],
      failedTasks: status === "failed" ? [taskId] : [],
      changedFiles: [],
      facts: status === "success" ? [`事实 ${taskId}`] : [],
      status: status === "success" ? "completed" : "failed"
    }
  };
}

function runtime(overrides: Partial<PlanningGraphRuntime> = {}): PlanningGraphRuntime {
  return {
    route: async () => plannedDecision,
    createPlan: async () => ({ status: "ready", plan: planWithExplorers([]) }),
    replan: async () => ({ status: "failed", reason: "model_error", blockers: ["未配置重规划"] }),
    executeExploreTask: async (plan, taskId) => exploration(plan, taskId),
    shouldReplan: async () => ({ shouldReplan: false, reason: "不需要", source: "rule" }),
    ...overrides
  };
}

test("ready 计划通过 validatePlan 后保持现有 Plan 契约", async () => {
  const plan = planWithExplorers([]);
  const result = await runPlanningGraph({ goal: "分析项目", readScope: ["src/**"] }, runtime({
    createPlan: async () => ({ status: "ready", plan })
  }), { maxConcurrency: 2 });

  assert.equal(result.planning?.status, "ready");
  if (result.planning?.status !== "ready") return;
  assert.deepEqual(result.planning.plan, plan);
  assert.deepEqual(result.explorations, []);
});

test("missing_context 经 Explorer 合并证据后重新规划", async () => {
  const plannerResults: PlannerResult[] = [
    { status: "missing_context", required: ["确认入口"] },
    { status: "ready", plan: planWithExplorers([]) }
  ];
  const knownFacts: string[][] = [];
  const result = await runPlanningGraph({ goal: "分析项目", readScope: ["src/**"] }, runtime({
    createPlan: async (input) => {
      knownFacts.push(input.knownFacts);
      return plannerResults.shift()!;
    }
  }), { maxConcurrency: 2 });

  assert.equal(result.planning?.status, "ready");
  assert.equal(result.explorations.length, 1);
  assert.match(knownFacts[1].join("\n"), /事实 EXPLORE-CONTEXT-1/);
  assert.match(knownFacts[1].join("\n"), /src\/EXPLORE-CONTEXT-1\.ts:1/);
});

test("Explorer 使用 Send 并行执行且 fan-in 不覆盖同批结果", async () => {
  let active = 0;
  let maxActive = 0;
  const plan = planWithExplorers(["E1", "E2", "E3"]);
  const result = await runPlanningGraph({ goal: "分析项目", readScope: ["src/**"] }, runtime({
    createPlan: async () => ({ status: "ready", plan }),
    executeExploreTask: async (currentPlan, taskId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return exploration(currentPlan, taskId);
    }
  }), { maxConcurrency: 2 });

  assert.equal(maxActive, 2);
  assert.equal(result.explorations.length, 3);
  assert.equal(result.planning?.status, "ready");
  if (result.planning?.status !== "ready") return;
  assert.deepEqual(
    result.planning.plan.tasks.filter((task) => task.type === "explore").map((task) => task.status),
    ["completed", "completed", "completed"]
  );
});

test("成功的 Explorer 结果推翻关键假设时也会触发重规划", async () => {
  const initialPlan = { ...planWithExplorers(["E1"]), assumptions: ["使用 JWT"] };
  const nextPlan = { ...planWithExplorers([]), version: 2, assumptions: [] };
  let replanCalls = 0;
  const result = await runPlanningGraph({ goal: "分析项目", readScope: ["src/**"] }, runtime({
    createPlan: async () => ({ status: "ready", plan: initialPlan }),
    shouldReplan: async () => ({ shouldReplan: true, reason: "新事实推翻 JWT 假设", source: "semantic" }),
    replan: async () => {
      replanCalls += 1;
      return { status: "ready", plan: nextPlan };
    }
  }), { maxConcurrency: 1, maxReplans: 1 });

  assert.equal(replanCalls, 1);
  assert.equal(result.replans?.length, 1);
  assert.equal(result.planning?.status, "ready");
  if (result.planning?.status !== "ready") return;
  assert.equal(result.planning.plan.version, 2);
});

test("Explorer 连续失败后执行有界重规划并返回新版计划", async () => {
  const initialPlan = planWithExplorers(["E1"]);
  const nextPlan = planWithExplorers([]);
  let attempts = 0;
  let replanCalls = 0;
  const result = await runPlanningGraph({ goal: "分析项目", readScope: ["src/**"] }, runtime({
    createPlan: async () => ({ status: "ready", plan: initialPlan }),
    executeExploreTask: async (plan, taskId) => {
      attempts += 1;
      return exploration(plan, taskId, "failed");
    },
    shouldReplan: async () => ({ shouldReplan: true, reason: "连续失败", source: "rule" }),
    replan: async () => {
      replanCalls += 1;
      return { status: "ready", plan: nextPlan };
    }
  }), { maxConcurrency: 1, maxReplans: 1 });

  assert.equal(attempts, 3);
  assert.equal(replanCalls, 1);
  assert.equal(result.replans?.length, 1);
  assert.equal(result.planning?.status, "ready");
});

test("重规划次数达到上限后明确 blocked 而不无限循环", async () => {
  const failingPlan = planWithExplorers(["E1"]);
  let replanCalls = 0;
  const result = await runPlanningGraph({ goal: "分析项目", readScope: ["src/**"] }, runtime({
    createPlan: async () => ({ status: "ready", plan: failingPlan }),
    executeExploreTask: async (plan, taskId) => exploration(plan, taskId, "failed"),
    shouldReplan: async () => ({ shouldReplan: true, reason: "连续失败", source: "rule" }),
    replan: async () => {
      replanCalls += 1;
      return { status: "ready", plan: { ...failingPlan, version: failingPlan.version + replanCalls } };
    }
  }), { maxConcurrency: 1, maxReplans: 1 });

  assert.equal(replanCalls, 1);
  assert.equal(result.planning?.status, "failed");
  if (result.planning?.status !== "failed") return;
  assert.match(result.planning.blockers.join("；"), /重规划次数已达到上限 1/);
});

test("缺少 readScope 时 missing_context 安全停止且不调用 Explorer", async () => {
  let explorerCalls = 0;
  const result = await runPlanningGraph({ goal: "分析项目" }, runtime({
    createPlan: async () => ({ status: "missing_context", required: ["确认仓库结构"] }),
    executeExploreTask: async (plan, taskId) => {
      explorerCalls += 1;
      return exploration(plan, taskId);
    }
  }), { maxConcurrency: 2 });

  assert.equal(result.planning?.status, "missing_context");
  assert.equal(explorerCalls, 0);
});
