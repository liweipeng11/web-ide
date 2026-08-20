import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MainOrchestrationResult } from "../agents/main/index.js";
import { executeApprovedAgentPipeline, executeDirectMainRequest } from "../agentOrchestrationService.js";
import { config } from "../config.js";
import { InMemoryWriteRuntimeGate } from "../langgraph/rollout/writeRuntimeGate.js";
import type { Plan, RouteDecision } from "../runtime/contracts.js";
import {
  approveTaskSessionPlan,
  createTaskSession,
  getTaskSession,
  setTaskSessionRuntimePlanning
} from "../taskSessionStore.js";
import type { TaskSession } from "../types.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

const directDecision: RouteDecision = {
  intent: "question",
  complexity: "simple",
  route: "direct",
  requiredCapabilities: []
};

function directResult(summary: string) {
  return {
    outcome: "executed" as const,
    decision: directDecision,
    execution: {
      result: { taskId: "MAIN", status: "success" as const, summary, facts: [], changedFiles: [], evidence: [], blockers: [] },
      state: { goal: "解释代码", completedTasks: ["MAIN"], failedTasks: [], changedFiles: [], facts: [], status: "completed" as const }
    }
  };
}

function writePlan(): Plan {
  return {
    version: 1,
    goal: "修改认证逻辑",
    assumptions: [],
    completionCriteria: ["修改完成"],
    tasks: [{
      id: "I1",
      type: "implement",
      goal: "修改认证逻辑",
      dependencies: [],
      requiredCapabilities: ["editing"],
      readScope: ["src/auth.ts"],
      writeScope: ["src/auth.ts"],
      acceptanceCriteria: ["修改完成"],
      status: "pending"
    }]
  };
}

async function approvedSession(): Promise<TaskSession> {
  const created = await createTaskSession("修改认证逻辑", { agentMode: "act" });
  await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: writePlan() });
  const approved = await approveTaskSessionPlan(created.id);
  assert.ok(approved);
  return approved;
}

function blockedResult(decision: RouteDecision, plan: Plan, summary: string): MainOrchestrationResult {
  return {
    status: "blocked",
    decision,
    plan,
    summary,
    changedFiles: [],
    results: [],
    executions: [],
    trace: { calledAgents: ["main"], events: [] }
  };
}

async function withWorkspace(run: () => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-stage9-"));
  const previousFlag = config.featureFlags.langGraphRuntime;
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run();
  } finally {
    config.featureFlags.langGraphRuntime = previousFlag;
    await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

test("阶段 9 只读 all 切换到 off 后立即恢复 Legacy 返回来源", async () => {
  await withWorkspace(async () => {
    const session = await createTaskSession("解释代码", { agentMode: "act" });
    let legacyCalls = 0;
    let graphCalls = 0;
    const runtime = {
      async plan() { return { decision: directDecision, planning: null }; },
      async executeDecision() { legacyCalls += 1; return directResult("Legacy 响应"); }
    };
    const rollout = {
      async execute() { graphCalls += 1; return directResult("Graph 响应"); }
    };

    const all = await executeDirectMainRequest(session, { goal: session.userGoal }, {
      runtime,
      readOnlyRollout: { mode: "all", ...rollout }
    });
    assert.equal(all.outcome === "executed" && all.summary, "Graph 响应");
    assert.deepEqual({ legacyCalls, graphCalls }, { legacyCalls: 0, graphCalls: 1 });

    const off = await executeDirectMainRequest(session, { goal: session.userGoal }, {
      runtime,
      readOnlyRollout: { mode: "off", ...rollout }
    });
    assert.equal(off.outcome === "executed" && off.summary, "Legacy 响应");
    assert.deepEqual({ legacyCalls, graphCalls }, { legacyCalls: 1, graphCalls: 1 });
  });
});

test("阶段 9 关闭写路径总开关后不迁移 TaskSession 即可恢复 Legacy", async () => {
  await withWorkspace(async () => {
    config.featureFlags.langGraphRuntime = true;
    const graphSession = await approvedSession();
    const graph = await executeApprovedAgentPipeline(graphSession, {
      writeRollout: { mode: "all", gate: new InMemoryWriteRuntimeGate() },
      orchestrator: {
        async executePlan(decision, plan) { return blockedResult(decision, plan, "Graph 控制面"); }
      }
    });
    assert.equal(graph.outcome, "executed");
    assert.equal((await getTaskSession(graphSession.id)).steps.some((step) => step.id.startsWith("graph-step:")), true);

    config.featureFlags.langGraphRuntime = false;
    const legacySession = await approvedSession();
    const legacy = await executeApprovedAgentPipeline(legacySession, {
      writeRollout: { mode: "all", gate: new InMemoryWriteRuntimeGate() },
      orchestrator: {
        async executePlan(decision, plan) { return blockedResult(decision, plan, "Legacy 控制面"); }
      }
    });
    assert.equal(legacy.outcome, "executed");
    if (legacy.outcome === "executed") assert.equal(legacy.orchestration.summary, "Legacy 控制面");
    assert.equal((await getTaskSession(legacySession.id)).steps.some((step) => step.id.startsWith("graph-step:")), false);
  });
});
