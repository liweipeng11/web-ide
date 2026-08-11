import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MainOrchestrationResult, OrchestrationExecution } from "./agents/main/index.js";
import { executeApprovedAgentPipeline, executeDirectMainRequest } from "./agentOrchestrationService.js";
import { config } from "./config.js";
import type { AgentState, Plan, RouteDecision } from "./runtime/contracts.js";
import {
  approveTaskSessionPlan,
  createTaskSession,
  getTaskSession,
  setTaskSessionRuntimePlanning
} from "./taskSessionStore.js";
import { initializeTaskPlan } from "./taskPlanService.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

function plan(): Plan {
  return {
    version: 1,
    goal: "修改并验证认证限流",
    assumptions: [],
    tasks: [
      {
        id: "T1",
        type: "implement",
        goal: "实现认证限流",
        dependencies: [],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth.ts"],
        writeScope: ["src/auth.ts"],
        acceptanceCriteria: ["第 6 次登录返回 429"],
        status: "pending"
      },
      {
        id: "T2",
        type: "test",
        goal: "验证认证限流",
        dependencies: ["T1"],
        requiredCapabilities: ["testing"],
        readScope: ["src/auth.ts", "tests/auth.test.ts"],
        writeScope: [],
        acceptanceCriteria: ["第 6 次登录返回 429"],
        status: "pending"
      }
    ],
    completionCriteria: ["第 6 次登录返回 429"]
  };
}

function state(currentPlan: Plan, changedFiles: string[]): AgentState {
  const completedTasks = currentPlan.tasks.filter((task) => task.status === "completed").map((task) => task.id);
  return {
    goal: currentPlan.goal,
    plan: currentPlan,
    completedTasks,
    failedTasks: [],
    changedFiles,
    facts: [],
    status: currentPlan.tasks.every((task) => task.status === "completed") ? "completed" : "running"
  };
}

function completeTask(currentPlan: Plan, taskId: string): Plan {
  return {
    ...currentPlan,
    tasks: currentPlan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : task)
  };
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-orchestration-service-"));
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("批准后的流水线连续持久化 Developer 和 Tester 产物", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("修改并验证认证限流", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);

    const result = await executeApprovedAgentPipeline(approved, {
      orchestrator: {
        async executePlan(decision, initialPlan, options): Promise<MainOrchestrationResult> {
          const developedPlan = completeTask(initialPlan, "T1");
          const developer: OrchestrationExecution = {
            agent: "developer",
            execution: {
              result: {
                taskId: "T1",
                status: "success",
                summary: "限流实现完成",
                facts: [],
                changedFiles: ["src/auth.ts"],
                evidence: ["src/auth.ts:1"],
                blockers: []
              },
              implementation: { summary: "限流实现完成", facts: [], evidence: ["src/auth.ts:1"] },
              checkpointIds: ["checkpoint-1"],
              state: state(developedPlan, ["src/auth.ts"])
            }
          };
          await options?.onExecution?.(developer);

          const testedPlan = completeTask(developedPlan, "T2");
          const tester: OrchestrationExecution = {
            agent: "tester",
            execution: {
              result: {
                taskId: "T2",
                status: "success",
                summary: "验证通过",
                facts: [],
                changedFiles: [],
                evidence: ["pnpm test：passed"],
                blockers: []
              },
              validation: {
                status: "passed",
                checks: { test: [{ status: "passed", command: "pnpm test", exitCode: 0, issueCount: 0 }] },
                failures: [],
                acceptanceCriteria: [{
                  criterion: "第 6 次登录返回 429",
                  status: "passed",
                  evidence: ["tests/auth.test.ts"]
                }],
                evidence: ["pnpm test：passed"],
                relatedTests: ["tests/auth.test.ts"]
              },
              state: state(testedPlan, ["src/auth.ts"])
            }
          };
          await options?.onExecution?.(tester);

          return {
            status: "completed",
            decision,
            plan: testedPlan,
            summary: "修改和验证完成",
            changedFiles: ["src/auth.ts"],
            results: [developer.execution.result, tester.execution.result],
            executions: [developer, tester],
            trace: { calledAgents: ["main", "developer", "tester"], events: [] }
          };
        }
      },
      testScope: ["tests/auth.test.ts"],
      acceptanceEvidence: [{ criterion: "第 6 次登录返回 429", testFiles: ["tests/auth.test.ts"] }]
    });

    assert.equal(result.outcome, "executed");
    if (result.outcome !== "executed") return;
    assert.equal(result.orchestration.status, "completed");
    const restored = await getTaskSession(created.id);
    assert.deepEqual(restored.runtimePlan?.tasks.map((task) => task.status), ["completed", "completed"]);
    assert.deepEqual(restored.filesChanged, ["src/auth.ts"]);
    assert.deepEqual(restored.checkpointIds, ["checkpoint-1"]);
    assert.equal(restored.developerArtifacts?.at(-1)?.summary, "限流实现完成");
    assert.equal(restored.testerArtifacts?.at(-1)?.validation.status, "passed");
    assert.deepEqual(restored.commandsRun, ["pnpm test"]);
    assert.deepEqual(restored.orchestrationTrace?.calledAgents, ["main", "developer", "tester"]);
    assert.equal(restored.orchestrationSummary, result.orchestration.summary);
  });
});

test("复杂任务跨审批请求恢复 Planner 和前置 Explorer 轨迹", async () => {
  await withWorkspace(async () => {
    const runtimePlan = plan();
    runtimePlan.tasks = [
      {
        id: "E1",
        type: "explore",
        goal: "定位认证实现",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/**", "tests/**"],
        writeScope: [],
        acceptanceCriteria: ["定位认证实现和测试"],
        status: "completed"
      },
      { ...runtimePlan.tasks[0], dependencies: ["E1"] },
      runtimePlan.tasks[1]
    ];
    const created = await createTaskSession("重构并验证认证限流", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: runtimePlan }, [{
      taskId: "E1",
      result: {
        summary: "已定位认证实现",
        relevantFiles: ["src/auth.ts", "tests/auth.test.ts"],
        facts: [{ statement: "认证实现在 src/auth.ts", evidence: ["src/auth.ts:1"] }],
        unknowns: []
      },
      createdAt: Date.now()
    }]);
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);

    const result = await executeApprovedAgentPipeline(approved, {
      orchestrator: {
        async executePlan(decision, initialPlan, options): Promise<MainOrchestrationResult> {
          assert.equal(decision.route, "planned");
          assert.deepEqual(options?.trace?.calledAgents, ["main", "planner", "explorer"]);
          return {
            status: "blocked",
            decision,
            plan: initialPlan,
            summary: "轨迹恢复验证完成",
            changedFiles: [],
            results: [],
            executions: [],
            trace: options?.trace ?? { calledAgents: [], events: [] }
          };
        }
      }
    });

    assert.equal(result.outcome, "executed");
    if (result.outcome !== "executed") return;
    assert.deepEqual(result.orchestration.trace.calledAgents, ["main", "planner", "explorer"]);
  });
});

test("simple 请求通过生产服务入口执行 Main 并持久化轨迹", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("解释登录函数", { agentMode: "act" });
    const routeDecision: RouteDecision = {
      intent: "question",
      complexity: "simple",
      route: "direct",
      requiredCapabilities: []
    };
    const result = await executeDirectMainRequest(created, { goal: created.userGoal }, {
      runtime: {
        async plan() {
          return { decision: routeDecision, planning: null };
        },
        async executeDecision() {
          return {
            outcome: "executed" as const,
            decision: routeDecision,
            execution: {
              result: {
                taskId: "MAIN-1",
                status: "success" as const,
                summary: "登录函数负责校验凭证。",
                facts: [],
                changedFiles: [],
                evidence: [],
                blockers: []
              },
              state: {
                goal: created.userGoal,
                plan: undefined,
                completedTasks: ["MAIN-1"],
                failedTasks: [],
                changedFiles: [],
                facts: [],
                status: "completed" as const
              }
            }
          };
        }
      }
    });

    assert.equal(result.outcome, "executed");
    if (result.outcome !== "executed") return;
    assert.equal(result.summary, "登录函数负责校验凭证。");
    const restored = await getTaskSession(created.id);
    assert.deepEqual(restored.orchestrationTrace?.calledAgents, ["main"]);
    assert.deepEqual(restored.orchestrationTrace?.events.map((event) => event.action), ["route", "finish"]);
    assert.equal(restored.orchestrationSummary, result.summary);
  });
});

test("非 direct 请求由生产服务入口交还现有链路", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("分析认证模块", { agentMode: "act" });
    let executionCalls = 0;
    const result = await executeDirectMainRequest(created, { goal: created.userGoal }, {
      runtime: {
        async plan() {
          return {
            decision: {
              intent: "analysis" as const,
              complexity: "medium" as const,
              route: "main_loop" as const,
              requiredCapabilities: ["read"]
            },
            planning: null
          };
        },
        async executeDecision() {
          executionCalls += 1;
          throw new Error("非 direct 请求不应在此执行");
        }
      }
    });

    assert.deepEqual(result, { outcome: "not_applicable" });
    assert.equal(executionCalls, 0);
  });
});

test("Tester 上下文只映射改动文件的相关测试并形成验收证据", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ scripts: { test: "tsx --test tests/*.test.ts" } }));
    await fs.writeFile(path.join(workspaceRoot, "src/auth.ts"), "export const authenticate = () => true;\n");
    await fs.writeFile(path.join(workspaceRoot, "tests/auth.test.ts"), "// auth acceptance test\n");

    const created = await createTaskSession("修改并验证认证限流", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);
    let resolved: { testScope: string[]; acceptanceEvidence: Array<{ criterion: string; testFiles: string[] }> } | null = null;

    await executeApprovedAgentPipeline(approved, {
      orchestrator: {
        async executePlan(decision, initialPlan, options): Promise<MainOrchestrationResult> {
          resolved = await options?.resolveTestContext?.(initialPlan.tasks[1], ["src/auth.ts"]) ?? null;
          return {
            status: "blocked",
            decision,
            plan: initialPlan,
            summary: "仅验证动态测试映射",
            changedFiles: ["src/auth.ts"],
            results: [],
            executions: [],
            trace: { calledAgents: ["main"], events: [] }
          };
        }
      }
    });

    const resolvedContext = resolved as { testScope: string[]; acceptanceEvidence: Array<{ criterion: string; testFiles: string[] }> } | null;
    assert.ok(resolvedContext);
    assert.deepEqual(resolvedContext.testScope, ["tests/auth.test.ts"]);
    assert.deepEqual(resolvedContext.acceptanceEvidence, [{
      criterion: plan().tasks[1].acceptanceCriteria[0],
      testFiles: ["tests/auth.test.ts"]
    }]);
  });
});

test("未批准计划不会启动统一编排", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("修改认证限流", { agentMode: "act" });
    const planned = await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
    assert.ok(planned);
    let calls = 0;

    const result = await executeApprovedAgentPipeline(planned, {
      orchestrator: {
        async executePlan(_decision: RouteDecision) {
          calls += 1;
          throw new Error("未批准计划不应执行");
        }
      }
    });

    assert.equal(result.outcome, "not_applicable");
    assert.equal(calls, 0);
  });
});

test("生产计划入口为 medium 修改建立无需 Planner 的 implement → test DAG", async () => {
  await withWorkspace(async () => {
    const previousApiKey = config.aiApiKey;
    config.aiApiKey = "";
    try {
      const created = await createTaskSession("修改登录函数并运行测试", { agentMode: "act" });
      let planningCalls = 0;
      const planned = await initializeTaskPlan(created, {
        intent: "edit",
        confidence: 1,
        normalizedGoal: created.userGoal,
        reason: "局部代码修改"
      }, {
        runtimePlanning: true,
        selectedPath: "src/auth.ts",
        runtimePlanner: {
          async plan() {
            planningCalls += 1;
            return {
              decision: {
                intent: "code_change",
                complexity: "medium",
                route: "main_loop",
                requiredCapabilities: ["read", "edit"]
              } as const,
              planning: null
            };
          }
        }
      });

      assert.equal(planningCalls, 1);
      assert.deepEqual(planned?.runtimePlan?.tasks.map((task) => task.type), ["implement", "test"]);
      assert.deepEqual(planned?.runtimePlan?.tasks[1]?.dependencies, ["IMPLEMENT-1"]);
      assert.equal(planned?.planApproval?.status, "pending");
    } finally {
      config.aiApiKey = previousApiKey;
    }
  });
});
