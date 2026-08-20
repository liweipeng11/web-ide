import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MainOrchestrationResult, OrchestrationExecution } from "./agents/main/index.js";
import { executeApprovedAgentPipeline, executeDirectMainRequest } from "./agentOrchestrationService.js";
import { config } from "./config.js";
import type { ReadOnlyRuntimeObservation } from "./langgraph/rollout/runtimeSelector.js";
import { InMemoryWriteRuntimeGate } from "./langgraph/rollout/writeRuntimeGate.js";
import { getRuntimeObservationContext } from "./langgraph/rollout/runtimeObservationContext.js";
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
            trace: {
              traceId: "trace-stage8",
              startedAt: 100,
              finishedAt: 140,
              calledAgents: ["main", "developer", "tester"],
              events: [{
                agent: "developer",
                action: "execute",
                taskId: "T1",
                status: "success",
                startedAt: 100,
                finishedAt: 140,
                durationMs: 40,
                attempt: 2,
                retries: 1,
                timeoutMs: 60_000,
                retryable: false,
                failureCategory: "none"
              }]
            }
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
    assert.equal(restored.orchestrationTrace?.traceId, "trace-stage8");
    assert.equal(restored.orchestrationTrace?.events[0]?.durationMs, 40);
    assert.equal(restored.orchestrationTrace?.events[0]?.retries, 1);
    assert.equal(restored.orchestrationSummary, result.orchestration.summary);
  });
});

test("批准后的流水线将角色生命周期桥接给统一会话事件流", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("修改并验证认证限流", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);
    const events: Array<{ agent: string; phase: string; taskId?: string; status?: string }> = [];

    await executeApprovedAgentPipeline(approved, {
      onLifecycleEvent(event) {
        events.push(event);
      },
      orchestrator: {
        async executePlan(decision, initialPlan, options): Promise<MainOrchestrationResult> {
          await options?.onLifecycleEvent?.({ agent: "developer", phase: "started", taskId: "T1" });
          const completedPlan = completeTask(initialPlan, "T1");
          const execution: OrchestrationExecution = {
            agent: "developer",
            execution: {
              result: { taskId: "T1", status: "success", summary: "限流实现完成", facts: [], changedFiles: ["src/auth.ts"], evidence: [], blockers: [] },
              implementation: { summary: "限流实现完成", facts: [], evidence: [] },
              checkpointIds: [],
              state: state(completedPlan, ["src/auth.ts"])
            }
          };
          await options?.onExecution?.(execution);
          await options?.onLifecycleEvent?.({ agent: "developer", phase: "completed", taskId: "T1", status: "success", summary: "限流实现完成" });
          return { status: "completed", decision, plan: completedPlan, summary: "完成", changedFiles: ["src/auth.ts"], results: [execution.execution.result], executions: [execution], trace: { calledAgents: ["main", "developer"], events: [] } };
        }
      }
    });

    assert.deepEqual(events, [
      { agent: "developer", phase: "started", taskId: "T1" },
      { agent: "developer", phase: "completed", taskId: "T1", status: "success", summary: "限流实现完成" }
    ]);
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

test("重规划后立即持久化新版 Plan 和 Replan 轨迹", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("根据认证事实重新规划", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);

    const result = await executeApprovedAgentPipeline(approved, {
      orchestrator: {
        async executePlan(decision, initialPlan, options): Promise<MainOrchestrationResult> {
          const revisedPlan = { ...initialPlan, version: 2 };
          await options?.onPlanUpdate?.(revisedPlan, "replan");
          await options?.onReplanExplorations?.(revisedPlan, [{
            result: {
              taskId: "EXPLORE-REPLAN-CONTEXT-2",
              status: "success",
              summary: "补充了 Session 存储事实",
              facts: ["Session 存储在 Redis"],
              changedFiles: [],
              evidence: ["src/session.ts:1"],
              blockers: []
            },
            exploration: {
              summary: "补充了 Session 存储事实",
              relevantFiles: ["src/session.ts"],
              facts: [{ statement: "Session 存储在 Redis", evidence: ["src/session.ts:1"] }],
              unknowns: []
            },
            state: state(revisedPlan, [])
          }]);
          return {
            status: "blocked",
            decision,
            plan: revisedPlan,
            summary: "新版计划已保存，等待继续执行",
            changedFiles: [],
            results: [],
            executions: [],
            trace: {
              calledAgents: ["main", "planner"],
              events: [{
                agent: "planner",
                action: "replan",
                status: "ready",
                reason: "认证实现事实推翻了 JWT 假设"
              }]
            }
          };
        }
      }
    });

    assert.equal(result.outcome, "executed");
    const restored = await getTaskSession(created.id);
    assert.equal(restored.runtimePlan?.version, 2);
    assert.equal(restored.orchestrationTrace?.events[0]?.action, "replan");
    assert.match(restored.orchestrationTrace?.events[0]?.reason ?? "", /JWT/);
    assert.equal(restored.explorerArtifacts?.some((artifact) => artifact.taskId === "EXPLORE-REPLAN-CONTEXT-2"), true);
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

test("只读 shadow 同时执行新路径但仍向用户返回 Legacy 结果", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("解释登录函数", { agentMode: "act" });
    const routeDecision: RouteDecision = { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] };
    const execution = (summary: string) => ({
      outcome: "executed" as const,
      decision: routeDecision,
      execution: {
        result: { taskId: "MAIN-READ", status: "success" as const, summary, facts: [], changedFiles: [], evidence: [], blockers: [] },
        state: { goal: created.userGoal, completedTasks: ["MAIN-READ"], failedTasks: [], changedFiles: [], facts: [], status: "completed" as const }
      }
    });
    const observations: unknown[] = [];
    const controlPlanes: string[] = [];
    const result = await executeDirectMainRequest(created, { goal: created.userGoal }, {
      runtime: {
        async plan() { return { decision: routeDecision, planning: null }; },
        async executeDecision() { controlPlanes.push(getRuntimeObservationContext().controlPlane); return execution("Legacy 回答"); }
      },
      readOnlyRollout: {
        mode: "shadow",
        async execute() { controlPlanes.push(getRuntimeObservationContext().controlPlane); return execution("新只读回答"); },
        observe(value) { observations.push(value); }
      }
    });

    assert.equal(result.outcome === "executed" && result.summary, "Legacy 回答");
    assert.equal(observations.length, 1);
    assert.deepEqual((observations[0] as ReadOnlyRuntimeObservation).comparison, {
      comparedDimensions: 3,
      differingDimensions: [],
      equivalent: true
    });
    assert.equal((observations[0] as ReadOnlyRuntimeObservation).selected, "legacy");
    assert.equal(JSON.stringify(observations).includes("回答"), false);
    assert.deepEqual(controlPlanes.sort(), ["langgraph", "legacy"]);
  });
});

test("internal 只在调用方明确标记内部任务时采用只读新结果", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("解释登录函数", { agentMode: "act" });
    const routeDecision: RouteDecision = { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] };
    const execution = (summary: string) => ({
      outcome: "executed" as const,
      decision: routeDecision,
      execution: {
        result: { taskId: "MAIN-INTERNAL", status: "success" as const, summary, facts: [], changedFiles: [], evidence: [], blockers: [] },
        state: { goal: created.userGoal, completedTasks: ["MAIN-INTERNAL"], failedTasks: [], changedFiles: [], facts: [], status: "completed" as const }
      }
    });
    const result = await executeDirectMainRequest(created, { goal: created.userGoal }, {
      runtime: {
        async plan() { return { decision: routeDecision, planning: null }; },
        async executeDecision() { return execution("Legacy 回答"); }
      },
      readOnlyRollout: {
        mode: "internal",
        internalTask: true,
        async execute() { return execution("内部只读回答"); },
        observe() {}
      }
    });

    assert.equal(result.outcome === "executed" && result.summary, "内部只读回答");
  });
});

test("全量只读灰度采用新结果并向执行器传递稳定 TaskSession 键", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("解释登录函数", { agentMode: "act" });
    const routeDecision: RouteDecision = { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] };
    const execution = (summary: string) => ({
      outcome: "executed" as const,
      decision: routeDecision,
      execution: {
        result: { taskId: "MAIN-ALL", status: "success" as const, summary, facts: [], changedFiles: [], evidence: [], blockers: [] },
        state: { goal: created.userGoal, completedTasks: ["MAIN-ALL"], failedTasks: [], changedFiles: [], facts: [], status: "completed" as const }
      }
    });
    let receivedRolloutKey: string | undefined;
    let runtimeContext: ReturnType<typeof getRuntimeObservationContext> | undefined;
    const result = await executeDirectMainRequest(created, { goal: created.userGoal }, {
      runtime: {
        async plan() { return { decision: routeDecision, planning: null }; },
        async executeDecision() { return execution("Legacy 回答"); }
      },
      readOnlyRollout: {
        mode: "all",
        async execute(request) {
          receivedRolloutKey = request.rolloutKey;
          runtimeContext = getRuntimeObservationContext();
          return execution("LangGraph 回答");
        }
      }
    });

    assert.equal(result.outcome === "executed" && result.summary, "LangGraph 回答");
    assert.equal(receivedRolloutKey, created.id);
    assert.deepEqual(runtimeContext, { controlPlane: "langgraph", rolloutMode: "all" });
  });
});

test("只读 main_loop 请求由生产 Main Graph 执行", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("分析认证模块", { agentMode: "act" });
    let executionCalls = 0;
    let runtimeContext: ReturnType<typeof getRuntimeObservationContext> | undefined;
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
        async executeDecision(_request, decision) {
          executionCalls += 1;
          runtimeContext = getRuntimeObservationContext();
          return {
            outcome: "executed" as const,
            decision,
            execution: {
              result: {
                taskId: "MAIN-READ",
                status: "success" as const,
                summary: "认证模块分析完成",
                facts: ["认证入口位于 src/auth.ts"],
                changedFiles: [],
                evidence: ["src/auth.ts:1"],
                blockers: []
              },
              state: {
                goal: created.userGoal,
                completedTasks: ["MAIN-READ"],
                failedTasks: [],
                changedFiles: [],
                facts: ["认证入口位于 src/auth.ts"],
                status: "completed" as const
              }
            }
          };
        }
      },
      readOnlyRollout: { mode: "all" }
    });

    assert.equal(result.outcome === "executed" && result.summary, "认证模块分析完成");
    assert.equal(executionCalls, 1);
    assert.deepEqual(runtimeContext, { controlPlane: "langgraph", rolloutMode: "all" });
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

test("LangGraph Flag 开启后批准任务保持生产服务返回契约和 TaskSession 结果", async () => {
  await withWorkspace(async () => {
    const previous = config.featureFlags.langGraphRuntime;
    config.featureFlags.langGraphRuntime = true;
    try {
      const created = await createTaskSession("修改并验证认证限流", { agentMode: "act" });
      await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
      const approved = await approveTaskSessionPlan(created.id);
      assert.ok(approved);
      let calls = 0;

      const result = await executeApprovedAgentPipeline(approved, {
        orchestrator: {
          async executePlan(decision, currentPlan, options): Promise<MainOrchestrationResult> {
            calls += 1;
            assert.equal(decision.route, "main_loop");
            assert.equal(currentPlan, approved.runtimePlan);
            return {
              status: "blocked",
              decision,
              plan: currentPlan,
              summary: "等待补充验收范围",
              changedFiles: [],
              results: [],
              executions: [],
              trace: options?.trace ?? { calledAgents: ["main"], events: [] }
            };
          }
        }
      });

      assert.equal(result.outcome, "executed");
      assert.equal(calls, 1);
      if (result.outcome !== "executed") return;
      assert.equal(result.orchestration.status, "blocked");
      assert.equal(result.orchestration.summary, "等待补充验收范围");
      const restored = await getTaskSession(created.id);
      assert.equal(restored.orchestrationSummary, "等待补充验收范围");
      const graphSteps = restored.steps.filter((step) => step.id.startsWith("graph-step:"));
      assert.ok(graphSteps.length >= 4);
      assert.equal(new Set(graphSteps.map((step) => step.id)).size, graphSteps.length);
    } finally {
      config.featureFlags.langGraphRuntime = previous;
    }
  });
});

test("写任务 all 模式 Graph 在无副作用失败时也不回退 Legacy", async () => {
  await withWorkspace(async () => {
    const previous = config.featureFlags.langGraphRuntime;
    config.featureFlags.langGraphRuntime = true;
    try {
      const created = await createTaskSession("修改认证限流", { agentMode: "act" });
      await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
      const approved = await approveTaskSessionPlan(created.id);
      assert.ok(approved);
      const gate = new InMemoryWriteRuntimeGate();
      let calls = 0;
      const runtimeContexts: Array<ReturnType<typeof getRuntimeObservationContext>> = [];

      await assert.rejects(executeApprovedAgentPipeline(approved, {
        writeRollout: { mode: "all", gate },
        orchestrator: {
          async executePlan(): Promise<MainOrchestrationResult> {
            calls += 1;
            runtimeContexts.push(getRuntimeObservationContext());
            throw new Error("Graph 控制面失败");
          }
        }
      }), /Graph 控制面失败/);

      assert.equal(calls, 1);
      assert.equal(gate.reason(), "runtime_failure");
      assert.deepEqual(runtimeContexts, [
        { controlPlane: "langgraph", rolloutMode: "all" }
      ]);
    } finally {
      config.featureFlags.langGraphRuntime = previous;
    }
  });
});

test("写任务 internal 模式一旦选中 Graph，失败时也不回退 Legacy", async () => {
  await withWorkspace(async () => {
    const previous = config.featureFlags.langGraphRuntime;
    config.featureFlags.langGraphRuntime = true;
    try {
      const created = await createTaskSession("修改认证限流", { agentMode: "act" });
      await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
      const approved = await approveTaskSessionPlan(created.id);
      assert.ok(approved);
      const gate = new InMemoryWriteRuntimeGate();
      let calls = 0;

      await assert.rejects(executeApprovedAgentPipeline(approved, {
        writeRollout: { mode: "internal", internalTask: true, gate },
        orchestrator: {
          async executePlan(): Promise<MainOrchestrationResult> {
            calls += 1;
            throw new Error("internal graph failed");
          }
        }
      }), /internal graph failed/);

      assert.equal(calls, 1);
      assert.equal(gate.reason(), "runtime_failure");
    } finally {
      config.featureFlags.langGraphRuntime = previous;
    }
  });
});

test("写任务 Graph 已报告越权文件时熔断且禁止整体重跑", async () => {
  await withWorkspace(async () => {
    const previous = config.featureFlags.langGraphRuntime;
    config.featureFlags.langGraphRuntime = true;
    try {
      const created = await createTaskSession("修改认证限流", { agentMode: "act" });
      await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: plan() });
      const approved = await approveTaskSessionPlan(created.id);
      assert.ok(approved);
      const gate = new InMemoryWriteRuntimeGate();
      let calls = 0;

      let capturedError: unknown;
      let capturedResult: unknown;
      try {
        capturedResult = await executeApprovedAgentPipeline(approved, {
          writeRollout: { mode: "all", gate },
          orchestrator: {
            async executePlan(decision, currentPlan): Promise<MainOrchestrationResult> {
              calls += 1;
              return {
                status: "completed",
                decision,
                plan: currentPlan,
                summary: "返回了越权文件",
                changedFiles: ["src/admin.ts"],
                results: [],
                executions: [],
                trace: { calledAgents: ["main", "developer"], events: [] }
              };
            }
          }
        });
      } catch (error) {
        capturedError = error;
      }

      assert.ok(capturedError instanceof Error && capturedError.message.includes("批准范围外"), JSON.stringify({ calls, gate: gate.reason(), capturedResult }));
      assert.equal(calls, 1);
      assert.equal(gate.reason(), "scope_violation");
    } finally {
      config.featureFlags.langGraphRuntime = previous;
    }
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
