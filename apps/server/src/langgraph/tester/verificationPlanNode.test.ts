import assert from "node:assert/strict";
import test from "node:test";
import type { Task } from "../../runtime/contracts.js";
import type { VerificationCommand, VerificationPlan } from "../../verifier/types.js";
import { createTesterGraphState } from "./testerGraphState.js";
import { prepareVerificationPlanNode, type VerificationPlanNodeDependencies } from "./verificationPlanNode.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T1",
    type: "test",
    goal: "验证认证修改",
    dependencies: ["I1"],
    requiredCapabilities: ["testing"],
    readScope: ["src/**", "tests/**"],
    writeScope: [],
    acceptanceCriteria: ["登录成功"],
    status: "pending",
    ...overrides
  };
}

function command(overrides: Partial<VerificationCommand> = {}): VerificationCommand {
  return {
    name: "test",
    command: "pnpm test",
    source: "package.json",
    reason: "项目测试脚本",
    stage: "test",
    ...overrides
  };
}

function plan(overrides: Partial<VerificationPlan> = {}): VerificationPlan {
  return {
    mode: "incremental",
    commands: [command()],
    changedFiles: ["src/auth.ts"],
    affectedPackages: [""],
    relatedTests: ["tests/auth.test.ts"],
    buildRequired: false,
    reasons: ["映射认证测试"],
    diagnostics: [],
    ...overrides
  };
}

function dependencies(value = plan()): VerificationPlanNodeDependencies {
  return {
    workspaceRoot: () => "C:/workspace",
    plan: async (_workspaceRoot, changedFiles) => ({ ...value, changedFiles: [...changedFiles] }),
    commandPolicy: (value) => value === "pnpm test"
      ? { level: "safe", reason: "测试白名单" }
      : { level: "confirm", reason: "未知命令" }
  };
}

function state() {
  return createTesterGraphState({
    task: task(),
    graphRunId: "run-1",
    completedTaskIds: ["I1"],
    changedFiles: ["src/auth.ts"],
    testScope: ["tests/**"],
    acceptanceEvidence: [{ criterion: "登录成功", testFiles: ["tests/auth.test.ts"] }]
  });
}

test("复用现有 verifier 生成安全计划且不执行命令", async () => {
  let planningCalls = 0;
  const input = state();
  const result = await prepareVerificationPlanNode(input, {
    ...dependencies(),
    plan: async (workspaceRoot, changedFiles) => {
      planningCalls += 1;
      assert.equal(workspaceRoot, "C:/workspace");
      assert.deepEqual(changedFiles, ["src/auth.ts"]);
      return plan();
    }
  });

  assert.equal(result.status, "plan_ready");
  assert.deepEqual(result.verificationPlan?.commands, [command()]);
  assert.equal(planningCalls, 1);
  assert.equal(input.status, "pending");
  assert.equal(input.verificationPlan, null);
});

test("任务类型、依赖、writeScope、改动范围和验收证据在规划前阻断", async () => {
  const cases = [
    createTesterGraphState({ ...state(), task: task({ type: "implement" }) }),
    createTesterGraphState({ ...state(), completedTaskIds: [] }),
    createTesterGraphState({ ...state(), task: task({ writeScope: ["src/**"] }) }),
    createTesterGraphState({ ...state(), changedFiles: ["private/secret.ts"] }),
    createTesterGraphState({ ...state(), testScope: ["private/tests/**"] }),
    createTesterGraphState({
      ...state(),
      acceptanceEvidence: [{ criterion: "未知条件", testFiles: ["tests/auth.test.ts"] }]
    }),
    createTesterGraphState({
      ...state(),
      acceptanceEvidence: [{ criterion: "登录成功", testFiles: ["outside/auth.test.ts"] }]
    })
  ];
  for (const value of cases) {
    let planned = false;
    const result = await prepareVerificationPlanNode(value, {
      ...dependencies(),
      plan: async () => {
        planned = true;
        return plan();
      }
    });
    assert.equal(result.status, "blocked");
    assert.equal(planned, false);
  }
});

test("拒绝空计划、伪造命令、非安全命令和 readScope 外测试", async () => {
  const cases = [
    plan({ commands: [] }),
    plan({ commands: [command({ source: "request" })] }),
    plan({ commands: [command({ command: "curl example.com" })] }),
    plan({ relatedTests: ["private/auth.test.ts"] }),
    plan({ relatedTests: ["src/auth.test.ts"] })
  ];
  for (const value of cases) {
    const result = await prepareVerificationPlanNode(state(), dependencies(value));
    assert.equal(result.status, "blocked");
    assert.ok(result.blockers?.length);
  }
});

test("验证计划不得改变 Graph 声明的 changedFiles", async () => {
  const deps = dependencies();
  deps.plan = async () => plan({ changedFiles: ["src/other.ts"] });
  const result = await prepareVerificationPlanNode(state(), deps);
  assert.equal(result.status, "blocked");
  assert.match(result.blockers?.join("；") ?? "", /changedFiles/);
});
