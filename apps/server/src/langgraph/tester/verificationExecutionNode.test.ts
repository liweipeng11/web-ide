import assert from "node:assert/strict";
import test from "node:test";
import type { CommandResult } from "../../types.js";
import type { VerificationCommand, VerificationIssueCategory, VerificationPlan, VerificationReport } from "../../verifier/types.js";
import { createTesterGraphState } from "./testerGraphState.js";
import { executeVerificationNode } from "./verificationExecutionNode.js";

function command(): VerificationCommand {
  return { name: "test", command: "pnpm test", source: "package.json", reason: "项目测试", stage: "test" };
}

function plan(): VerificationPlan {
  return {
    mode: "incremental",
    commands: [command()],
    changedFiles: ["src/auth.ts"],
    affectedPackages: [""],
    relatedTests: ["tests/auth.test.ts"],
    buildRequired: false,
    reasons: ["认证改动映射到认证测试"],
    diagnostics: []
  };
}

function result(status: CommandResult["status"]): CommandResult {
  return {
    command: "pnpm test",
    cwd: "C:/workspace",
    status,
    exitCode: status === "success" ? 0 : status === "cancelled" ? null : 1,
    stdout: "",
    stderr: status === "failed" ? "expected 200, actual 500" : "",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

function report(
  status: VerificationReport["status"],
  options: { category?: VerificationIssueCategory; includeExecution?: boolean } = {}
): VerificationReport {
  const includeExecution = options.includeExecution ?? true;
  const execution = {
    command: command(),
    policy: { level: "safe" as const, reason: "测试白名单" },
    ...(status === "needs_confirmation" || status === "blocked" || status === "no_commands"
      ? {}
      : { result: result(status === "success" ? "success" : status === "cancelled" ? "cancelled" : "failed") }),
    issues: options.category ? [{ category: options.category, message: `classified ${options.category}` }] : []
  };
  const executions = includeExecution ? [execution] : [];
  return {
    status,
    plannedCommands: [command()],
    plan: plan(),
    executions,
    ...(status === "success" || !includeExecution ? {} : { failedExecution: execution })
  };
}

function readyState() {
  return {
    ...createTesterGraphState({
      task: {
        id: "T1",
        type: "test" as const,
        goal: "验证认证修改",
        dependencies: ["I1"],
        requiredCapabilities: ["testing"],
        readScope: ["src/**", "tests/**"],
        writeScope: [],
        acceptanceCriteria: ["登录成功"],
        status: "pending" as const
      },
      graphRunId: "run-1",
      completedTaskIds: ["I1"],
      changedFiles: ["src/auth.ts"],
      testScope: ["tests/**"],
      acceptanceEvidence: [{ criterion: "登录成功", testFiles: ["tests/auth.test.ts"] }]
    }),
    status: "plan_ready" as const,
    verificationPlan: plan()
  };
}

test("执行冻结计划并把真实测试成功转换为 passed", async () => {
  const state = readyState();
  let receivedPlan: VerificationPlan | null = null;
  const update = await executeVerificationNode(state, {
    execute: async (value) => {
      receivedPlan = value;
      return report("success");
    }
  });

  assert.equal(receivedPlan, state.verificationPlan);
  assert.equal(update.status, "passed");
  assert.equal(update.failureClass, "none");
  assert.equal(update.validation?.acceptanceCriteria[0].status, "passed");
  assert.equal(state.validation, null);
});

test("语法、类型、lint、测试和构建失败分类为 implementation", async () => {
  for (const category of ["syntax", "type", "lint", "test", "build"] as const) {
    const update = await executeVerificationNode(readyState(), { execute: async () => report("failed", { category }) });
    assert.equal(update.status, "failed");
    assert.equal(update.failureClass, "implementation");
    assert.match(update.blockers?.[0] ?? "", new RegExp(category));
  }
});

test("超时、命令异常和策略阻止分类为 environment", async () => {
  for (const category of ["timeout", "command", "unknown"] as const) {
    const update = await executeVerificationNode(readyState(), { execute: async () => report("failed", { category }) });
    assert.equal(update.failureClass, "environment");
  }
  const blocked = await executeVerificationNode(readyState(), { execute: async () => report("blocked") });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.failureClass, "environment");
  assert.match(blocked.blockers?.[0] ?? "", /安全策略/);
});

test("测试成功但验收映射不足分类为 plan，取消保持 cancelled", async () => {
  const missingEvidence = readyState();
  missingEvidence.acceptanceEvidence = [];
  const planned = await executeVerificationNode(missingEvidence, { execute: async () => report("success") });
  assert.equal(planned.status, "blocked");
  assert.equal(planned.failureClass, "plan");

  const cancelled = await executeVerificationNode(readyState(), { execute: async () => report("cancelled") });
  assert.equal(cancelled.status, "blocked");
  assert.equal(cancelled.failureClass, "cancelled");
  assert.match(cancelled.blockers?.[0] ?? "", /取消/);
});

test("没有通过 7A 门禁时不会执行任何命令", async () => {
  let called = false;
  const ready = readyState();
  const pending = createTesterGraphState({
    task: ready.task,
    graphRunId: ready.graphRunId,
    completedTaskIds: ready.completedTaskIds,
    changedFiles: ready.changedFiles,
    testScope: ready.testScope,
    acceptanceEvidence: ready.acceptanceEvidence
  });
  const update = await executeVerificationNode(pending, {
    execute: async () => {
      called = true;
      return report("success");
    }
  });
  assert.equal(called, false);
  assert.equal(update.status, "blocked");
  assert.equal(update.failureClass, "plan");
});
