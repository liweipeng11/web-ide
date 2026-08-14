import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationPlan } from "../../verifier/types.js";
import { createTesterGraphState, type TesterFailureClass, type TesterGraphStateValue } from "./testerGraphState.js";
import { createRepairLoopGraph } from "./repairLoopGraph.js";

function plan(): VerificationPlan {
  return {
    mode: "incremental",
    commands: [{ name: "test", command: "pnpm test", source: "package.json", reason: "测试", stage: "test" }],
    changedFiles: ["src/auth.ts"],
    affectedPackages: [""],
    relatedTests: ["tests/auth.test.ts"],
    buildRequired: false,
    reasons: [],
    diagnostics: []
  };
}

function readyState(): TesterGraphStateValue {
  return {
    ...createTesterGraphState({
      task: {
        id: "T1",
        type: "test",
        goal: "验证认证修改",
        dependencies: ["I1"],
        requiredCapabilities: ["testing"],
        readScope: ["src/**", "tests/**"],
        writeScope: [],
        acceptanceCriteria: ["登录成功"],
        status: "pending"
      },
      graphRunId: "run-1",
      completedTaskIds: ["I1"],
      changedFiles: ["src/auth.ts"],
      testScope: ["tests/**"],
      acceptanceEvidence: [{ criterion: "登录成功", testFiles: ["tests/auth.test.ts"] }]
    }),
    status: "plan_ready",
    verificationPlan: plan()
  };
}

function verification(failureClass: TesterFailureClass) {
  return {
    status: failureClass === "none" ? "passed" as const : failureClass === "implementation" ? "failed" as const : "blocked" as const,
    failureClass,
    blockers: failureClass === "none" ? [] : [`${failureClass} failure`]
  };
}

function refreshed(state: TesterGraphStateValue): TesterGraphStateValue {
  return {
    ...state,
    status: "plan_ready",
    verificationPlan: plan(),
    validation: null,
    failureClass: "none",
    blockers: []
  };
}

test("实现失败只回到 Developer，并在复验通过后结束", async () => {
  let verifies = 0;
  let developerCalls = 0;
  let replanCalls = 0;
  const loop = createRepairLoopGraph({
    maxDeveloperAttempts: 2,
    maxReplans: 1,
    maxSteps: 5,
    dependencies: {
      verify: async () => verification(verifies++ === 0 ? "implementation" : "none"),
      develop: async (state) => {
        developerCalls += 1;
        return refreshed(state.tester);
      },
      replan: async (state) => {
        replanCalls += 1;
        return refreshed(state.tester);
      }
    }
  });
  const result = await loop.invoke(readyState());
  assert.equal(result.outcome, "passed");
  assert.equal(result.verificationAttempts, 2);
  assert.equal(developerCalls, 1);
  assert.equal(replanCalls, 0);
  assert.deepEqual(result.history, ["verify:implementation:failed", "develop:1", "verify:none:passed"]);
});

test("计划失败只进入 Planner，并在重规划后复验", async () => {
  let verifies = 0;
  let developerCalls = 0;
  let replanCalls = 0;
  const loop = createRepairLoopGraph({
    maxDeveloperAttempts: 2,
    maxReplans: 1,
    dependencies: {
      verify: async () => verification(verifies++ === 0 ? "plan" : "none"),
      develop: async (state) => {
        developerCalls += 1;
        return refreshed(state.tester);
      },
      replan: async (state) => {
        replanCalls += 1;
        return refreshed(state.tester);
      }
    }
  });
  const result = await loop.invoke(readyState());
  assert.equal(result.outcome, "passed");
  assert.equal(developerCalls, 0);
  assert.equal(replanCalls, 1);
});

test("环境问题和取消直接停止，不调用 Developer 或 Planner", async () => {
  for (const failureClass of ["environment", "cancelled"] as const) {
    let recoveryCalls = 0;
    const loop = createRepairLoopGraph({
      dependencies: {
        verify: async () => verification(failureClass),
        develop: async (state) => {
          recoveryCalls += 1;
          return refreshed(state.tester);
        },
        replan: async (state) => {
          recoveryCalls += 1;
          return refreshed(state.tester);
        }
      }
    });
    const result = await loop.invoke(readyState());
    assert.equal(result.outcome, failureClass === "cancelled" ? "cancelled" : "blocked");
    assert.equal(recoveryCalls, 0);
  }
});

test("同类实现失败和重规划达到上限后返回 incomplete", async () => {
  const implementationLoop = createRepairLoopGraph({
    maxDeveloperAttempts: 2,
    maxReplans: 1,
    dependencies: {
      verify: async () => verification("implementation"),
      develop: async (state) => refreshed(state.tester),
      replan: async (state) => refreshed(state.tester)
    }
  });
  const implementation = await implementationLoop.invoke(readyState());
  assert.equal(implementation.outcome, "incomplete");
  assert.equal(implementation.developerAttempts, 2);
  assert.match(implementation.blocker ?? "", /Developer.*上限 2/);

  const planLoop = createRepairLoopGraph({
    maxDeveloperAttempts: 2,
    maxReplans: 1,
    dependencies: {
      verify: async () => verification("plan"),
      develop: async (state) => refreshed(state.tester),
      replan: async (state) => refreshed(state.tester)
    }
  });
  const planned = await planLoop.invoke(readyState());
  assert.equal(planned.outcome, "incomplete");
  assert.equal(planned.replanAttempts, 1);
  assert.match(planned.blocker ?? "", /重规划.*上限 1/);
});

test("Developer 或 Planner 不能直接伪造通过状态", async () => {
  const loop = createRepairLoopGraph({
    dependencies: {
      verify: async () => verification("implementation"),
      develop: async (state) => ({ ...state.tester, status: "passed" }),
      replan: async (state) => refreshed(state.tester)
    }
  });
  await assert.rejects(() => loop.invoke(readyState()), /重新通过 Tester 验证计划门禁/);
});

test("无效循环上限在编译 Graph 前被拒绝", () => {
  assert.throws(() => createRepairLoopGraph({
    maxDeveloperAttempts: 0,
    dependencies: {
      verify: async () => verification("none"),
      develop: async (state) => refreshed(state.tester),
      replan: async (state) => refreshed(state.tester)
    }
  }), /正整数/);
});
