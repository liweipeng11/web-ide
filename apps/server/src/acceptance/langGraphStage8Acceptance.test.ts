import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MainOrchestrationResult } from "../agents/main/index.js";
import {
  executeApprovedAgentPipeline,
  executeDirectMainRequest
} from "../agentOrchestrationService.js";
import { config } from "../config.js";
import { readApprovedTaskSessionMainGraphState } from "../langgraph/main/taskSessionMainGraph.js";
import type { Plan, RouteDecision } from "../runtime/contracts.js";
import { createAgentStep } from "../routeAgentSteps.js";
import {
  appendTaskSessionStep,
  approveTaskSessionPlan,
  createTaskSession,
  getTaskSession,
  setTaskSessionRuntimePlanning
} from "../taskSessionStore.js";
import type { AgentStep, TaskSession } from "../types.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

function runtimePlan(withExploration = false): Plan {
  return {
    version: 1,
    goal: withExploration ? "跨模块修改并验证认证逻辑" : "修改并验证认证逻辑",
    assumptions: [],
    completionCriteria: ["认证测试通过"],
    tasks: [
      ...(withExploration ? [{
        id: "E1",
        type: "explore" as const,
        goal: "定位认证实现",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/**", "tests/**"],
        writeScope: [],
        acceptanceCriteria: ["定位实现与测试"],
        status: "completed" as const
      }] : []),
      {
        id: "I1",
        type: "implement" as const,
        goal: "修改认证逻辑",
        dependencies: withExploration ? ["E1"] : [],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth.ts"],
        writeScope: ["src/auth.ts"],
        acceptanceCriteria: ["修改完成"],
        status: "pending" as const
      },
      {
        id: "T1",
        type: "test" as const,
        goal: "验证认证逻辑",
        dependencies: ["I1"],
        requiredCapabilities: ["testing"],
        readScope: ["src/auth.ts", "tests/auth.test.ts"],
        writeScope: [],
        acceptanceCriteria: ["认证测试通过"],
        status: "pending" as const
      }
    ]
  };
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-stage8-"));
  const previousFlag = config.featureFlags.langGraphRuntime;
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    config.featureFlags.langGraphRuntime = previousFlag;
    await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

function stepLabel(step: AgentStep): string {
  if (step.type === "orchestration") return `${step.agent}:${step.phase}:${step.status ?? "none"}`;
  return step.type;
}

async function approvedSession(plan: Plan): Promise<TaskSession> {
  const created = await createTaskSession(plan.goal, { agentMode: "act" });
  await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan });
  const approved = await approveTaskSessionPlan(created.id);
  assert.ok(approved);
  return approved;
}

test("阶段 8 internal Main Graph 保持 SSE 顺序、TaskSession 刷新和复杂路由兼容", async () => {
  await withWorkspace(async () => {
    config.featureFlags.langGraphRuntime = true;

    for (const withExploration of [false, true]) {
      const session = await approvedSession(runtimePlan(withExploration));
      const streamed: string[] = [];
      const result = await executeApprovedAgentPipeline(session, {
        async onGraphStep(step) {
          // 服务回调发生前步骤必须已经落盘，刷新读取不会丢失当前事件。
          const refreshed = await getTaskSession(session.id);
          assert.equal(refreshed.steps.some((item) => item.id === step.id), true);
          streamed.push(`graph:${stepLabel(step)}`);
        },
        async onLifecycleEvent(event) {
          const step = createAgentStep({ type: "orchestration", ...event });
          await appendTaskSessionStep(session.id, step);
          streamed.push(`agent:${stepLabel(step)}`);
        },
        orchestrator: {
          async executePlan(decision, plan, options): Promise<MainOrchestrationResult> {
            assert.equal(decision.route, withExploration ? "planned" : "main_loop");
            await options?.onLifecycleEvent?.({ agent: "developer", phase: "started", taskId: "I1" });
            await options?.onLifecycleEvent?.({ agent: "developer", phase: "completed", taskId: "I1", status: "blocked", summary: "等待真实补丁" });
            return {
              status: "blocked",
              decision,
              plan,
              summary: "等待真实补丁",
              changedFiles: [],
              results: [],
              executions: [],
              trace: options?.trace ?? { calledAgents: ["main"], events: [] }
            };
          }
        }
      });

      assert.equal(result.outcome, "executed");
      assert.ok(streamed[0]?.startsWith("graph:main:started"));
      assert.ok(streamed.some((item) => item === "agent:developer:started:none"));
      assert.ok(streamed.at(-1)?.startsWith("graph:message"));

      const refreshed = await getTaskSession(session.id);
      const graphSteps = refreshed.steps.filter((step) => step.id.startsWith("graph-step:"));
      assert.ok(graphSteps.length >= (withExploration ? 6 : 5));
      assert.equal(new Set(graphSteps.map((step) => step.id)).size, graphSteps.length);
      const snapshot = await readApprovedTaskSessionMainGraphState({ session: refreshed });
      assert.equal(snapshot?.branch, withExploration ? "planned" : "main_loop");
      assert.equal(snapshot?.outcome, "blocked");
    }
  });
});

test("阶段 8 direct、审批等待和 Legacy 回退可同时使用且不误启动 Graph", async () => {
  await withWorkspace(async () => {
    const directSession = await createTaskSession("解释认证函数", { agentMode: "act" });
    const directDecision: RouteDecision = {
      intent: "question",
      complexity: "simple",
      route: "direct",
      requiredCapabilities: []
    };
    const direct = await executeDirectMainRequest(directSession, { goal: directSession.userGoal }, {
      runtime: {
        async plan() { return { decision: directDecision, planning: null }; },
        async executeDecision() {
          return {
            outcome: "executed" as const,
            decision: directDecision,
            execution: {
              result: { taskId: "MAIN", status: "success" as const, summary: "认证函数负责校验凭证。", facts: [], changedFiles: [], evidence: [], blockers: [] },
              state: { goal: directSession.userGoal, completedTasks: ["MAIN"], failedTasks: [], changedFiles: [], facts: [], status: "completed" as const }
            }
          };
        }
      }
    });
    assert.equal(direct.outcome === "executed" && direct.summary, "认证函数负责校验凭证。");

    config.featureFlags.langGraphRuntime = true;
    const pending = await createTaskSession("等待批准", { agentMode: "act" });
    const planned = await setTaskSessionRuntimePlanning(pending.id, { status: "ready", plan: runtimePlan() });
    assert.ok(planned);
    let calls = 0;
    const waiting = await executeApprovedAgentPipeline(planned, {
      orchestrator: { async executePlan() { calls += 1; throw new Error("不应执行"); } }
    });
    assert.equal(waiting.outcome, "not_applicable");
    assert.equal(calls, 0);

    config.featureFlags.langGraphRuntime = false;
    const legacy = await approvedSession(runtimePlan());
    const legacyResult = await executeApprovedAgentPipeline(legacy, {
      orchestrator: {
        async executePlan(decision, plan): Promise<MainOrchestrationResult> {
          calls += 1;
          return { status: "blocked", decision, plan, summary: "Legacy 保持可用", changedFiles: [], results: [], executions: [], trace: { calledAgents: ["main"], events: [] } };
        }
      }
    });
    assert.equal(legacyResult.outcome, "executed");
    assert.equal(calls, 1);
    assert.equal((await getTaskSession(legacy.id)).steps.some((step) => step.id.startsWith("graph-step:")), false);
  });
});
