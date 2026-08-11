import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plan } from "./runtime/contracts.js";
import {
  approveTaskSessionPlan,
  createTaskSession,
  getTaskSession,
  setTaskSessionRuntimePlanning
} from "./taskSessionStore.js";
import { executeApprovedTesterTask } from "./testerExecutionService.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

function createPlan(): Plan {
  return {
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
        readScope: ["src/**"],
        writeScope: ["src/**"],
        acceptanceCriteria: ["实现完成"],
        status: "completed"
      },
      {
        id: "T3",
        type: "test",
        goal: "验证认证限流",
        dependencies: ["T2"],
        requiredCapabilities: ["testing"],
        readScope: ["src/**", "tests/**", "package.json"],
        writeScope: [],
        acceptanceCriteria: ["第 6 次登录返回 429"],
        status: "pending"
      }
    ],
    completionCriteria: ["认证限流验证通过"]
  };
}

async function withWorkspace(run: () => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-tester-service-"));
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run();
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("已批准 test Task 通过生产服务执行并持久化结构化 TesterArtifact", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("验证认证限流", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: createPlan() });
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);
    let receivedEvidence: unknown;

    const result = await executeApprovedTesterTask(approved, {
      changedFiles: ["src/auth.ts"],
      testScope: ["tests/auth/**"],
      acceptanceEvidence: [{ criterion: "第 6 次登录返回 429", testFiles: ["tests/auth/rate-limit.test.ts"] }],
      runtime: {
        async executeTestTask(plan, taskId, options) {
          receivedEvidence = options.acceptanceEvidence;
          const nextPlan: Plan = {
            ...plan,
            tasks: plan.tasks.map((task) => task.id === taskId ? { ...task, status: "completed" as const } : task)
          };
          return {
            result: {
              taskId,
              status: "success",
              summary: "验证通过",
              facts: ["相关测试：tests/auth/rate-limit.test.ts"],
              changedFiles: [],
              evidence: ["pnpm test：passed，退出码 0"],
              blockers: []
            },
            validation: {
              status: "passed",
              checks: { test: [{ status: "passed", command: "pnpm test", exitCode: 0, issueCount: 0 }] },
              failures: [],
              acceptanceCriteria: [{
                criterion: "第 6 次登录返回 429",
                status: "passed",
                evidence: ["pnpm test", "tests/auth/rate-limit.test.ts"]
              }],
              evidence: ["pnpm test：passed，退出码 0"],
              relatedTests: ["tests/auth/rate-limit.test.ts"]
            },
            state: {
              goal: plan.goal,
              plan: nextPlan,
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

    assert.equal(result.outcome, "executed");
    assert.deepEqual(receivedEvidence, [{ criterion: "第 6 次登录返回 429", testFiles: ["tests/auth/rate-limit.test.ts"] }]);
    const restored = await getTaskSession(created.id);
    assert.equal(restored.runtimePlan?.tasks.find((task) => task.id === "T3")?.status, "completed");
    assert.equal(restored.testerArtifacts?.at(-1)?.validation.status, "passed");
    assert.deepEqual(restored.commandsRun, ["pnpm test"]);
    assert.doesNotMatch(JSON.stringify(restored.testerArtifacts), /完整 stdout|完整 stderr/);
  });
});

test("生产 Tester 服务不会执行未批准计划", async () => {
  await withWorkspace(async () => {
    const created = await createTaskSession("验证认证限流", { agentMode: "act" });
    const planned = await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: createPlan() });
    assert.ok(planned);
    let calls = 0;
    const result = await executeApprovedTesterTask(planned, {
      runtime: {
        async executeTestTask() {
          calls += 1;
          throw new Error("未批准计划不应执行 Tester");
        }
      }
    });

    assert.equal(result.outcome, "not_applicable");
    assert.equal(calls, 0);
  });
});
