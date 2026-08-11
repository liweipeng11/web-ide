import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plan } from "../../runtime/contracts.js";
import { getWorkspaceRoot, setWorkspaceRoot } from "../../workspaceStore.js";
import { TesterAgentRuntime } from "./testerAgentRuntime.js";

function createPlan(testStatus: Plan["tasks"][number]["status"] = "pending"): Plan {
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
        acceptanceCriteria: ["限流实现完成"],
        status: testStatus === "pending" ? "completed" : "pending"
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
        status: testStatus
      }
    ],
    completionCriteria: ["认证限流通过测试"]
  };
}

async function withWorkspace(testBody: (workspaceRoot: string) => Promise<void>) {
  const previousRoot = getWorkspaceRoot();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-tester-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "tests", "auth"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "auth.js"), "export const status = 429;\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "tests", "auth", "rate-limit.test.js"), [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'test("第 6 次登录返回 429", () => assert.equal(429, 429));',
      ""
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      private: true,
      type: "module",
      scripts: { test: "node --test tests/auth/rate-limit.test.js" }
    }), "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await testBody(workspaceRoot);
  } finally {
    if (previousRoot) await setWorkspaceRoot(previousRoot, { persist: false });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("Tester Runtime 执行真实相关测试并更新 Plan 状态", async () => {
  await withWorkspace(async () => {
    const execution = await new TesterAgentRuntime().executePlanTask(createPlan(), "T3", {
      changedFiles: ["src/auth.js"],
      testScope: ["tests/auth/**"],
      acceptanceEvidence: [{ criterion: "第 6 次登录返回 429", testFiles: ["tests/auth/rate-limit.test.js"] }]
    });

    assert.equal(execution.result.status, "success");
    assert.equal(execution.validation?.status, "passed");
    assert.deepEqual(execution.result.changedFiles, []);
    assert.deepEqual(execution.state.completedTasks.sort(), ["T2", "T3"]);
    assert.ok(execution.validation?.relatedTests.includes("tests/auth/rate-limit.test.js"));
  });
});

test("Tester Runtime 拒绝非测试任务、写范围和未完成依赖", async () => {
  const runtime = new TesterAgentRuntime();
  await assert.rejects(
    () => runtime.executePlanTask(createPlan(), "T2", { changedFiles: ["src/auth.js"], testScope: ["tests/**"] }),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );

  const writePlan = createPlan();
  writePlan.tasks[1].writeScope = ["tests/**"];
  await assert.rejects(
    () => runtime.executePlanTask(writePlan, "T3", { changedFiles: ["src/auth.js"], testScope: ["tests/**"] }),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );

  const blockedPlan = createPlan("blocked");
  await assert.rejects(
    () => runtime.executePlanTask(blockedPlan, "T3", { changedFiles: ["src/auth.js"], testScope: ["tests/**"] }),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "TASK_DEPENDENCY_NOT_SATISFIED")
  );
});
