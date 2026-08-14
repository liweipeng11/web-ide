import assert from "node:assert/strict";
import test from "node:test";
import type { CompletionEvidence } from "../agentCompletionPolicy.js";
import { evaluateRepairLoopCompletion, type RepairCompletionEvidenceInput } from "../langgraph/tester/completionGate.js";
import { createRepairLoopGraph } from "../langgraph/tester/repairLoopGraph.js";
import { createTesterGraphState, type TesterGraphStateValue } from "../langgraph/tester/testerGraphState.js";
import type { ValidationReport } from "../agents/tester/contracts.js";

function validation(): ValidationReport {
  return {
    status: "passed",
    checks: { test: [{ status: "passed", command: "pnpm test", exitCode: 0, issueCount: 0 }] },
    failures: [],
    acceptanceCriteria: [{ criterion: "登录成功", status: "passed", evidence: ["pnpm test", "tests/auth.test.ts"] }],
    evidence: ["pnpm test：passed，退出码 0"],
    relatedTests: ["tests/auth.test.ts"]
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
    verificationPlan: {
      mode: "incremental",
      commands: [{ name: "test", command: "pnpm test", source: "package.json", reason: "测试", stage: "test" }],
      changedFiles: ["src/auth.ts"],
      affectedPackages: [""],
      relatedTests: ["tests/auth.test.ts"],
      buildRequired: false,
      reasons: [],
      diagnostics: []
    }
  };
}

function evidence(overrides: Partial<RepairCompletionEvidenceInput> = {}): RepairCompletionEvidenceInput {
  return {
    changedFiles: ["src/auth.ts"],
    generatedPatchCount: 1,
    pendingPatchCount: 0,
    pendingPlanCount: 0,
    blockedPlanCount: 0,
    pendingApprovalCount: 0,
    activeCommandCount: 0,
    failedToolCallCount: 0,
    lastMutationAt: 100,
    lastValidationAt: 200,
    ...overrides
  };
}

async function passedLoop() {
  const loop = createRepairLoopGraph({
    dependencies: {
      verify: async () => ({ status: "passed", failureClass: "none", blockers: [], validation: validation() }),
      develop: async (state) => state.tester,
      replan: async (state) => state.tester
    }
  });
  return loop.invoke(readyState());
}

test("阶段 7 只有真实变更、最新验证和完整验收映射同时存在时完成", async () => {
  const loop = await passedLoop();
  const completed = evaluateRepairLoopCompletion({ loop, evidence: evidence(), finalContent: "认证修改与验证均已完成。" });
  assert.equal(completed.status, "completed");
  assert.equal(completed.decision.code, "COMPLETED");
  assert.equal(completed.evidence.changedFileCount, 1);

  const noMutation = evaluateRepairLoopCompletion({ loop, evidence: evidence({ changedFiles: [] }), finalContent: "已完成。" });
  assert.equal(noMutation.status, "incomplete");
  assert.equal(noMutation.decision?.code, "NO_MUTATION_EVIDENCE");

  const stale = evaluateRepairLoopCompletion({
    loop,
    evidence: evidence({ lastMutationAt: 300, lastValidationAt: 200 }),
    finalContent: "已完成。"
  });
  assert.equal(stale.status, "incomplete");
  assert.equal(stale.decision?.code, "VALIDATION_STALE");
});

test("环境阻塞、取消和循环耗尽不会进入完成策略", async () => {
  for (const failureClass of ["environment", "cancelled", "implementation"] as const) {
    const loop = createRepairLoopGraph({
      maxDeveloperAttempts: 1,
      dependencies: {
        verify: async () => ({
          status: failureClass === "implementation" ? "failed" : "blocked",
          failureClass,
          blockers: [`${failureClass} blocker`]
        }),
        develop: async (state) => ({ ...state.tester, status: "plan_ready", failureClass: "none", validation: null }),
        replan: async (state) => state.tester
      }
    });
    const result = await loop.invoke(readyState());
    const gated = evaluateRepairLoopCompletion({ loop: result, evidence: evidence(), finalContent: "已完成。" });
    assert.notEqual(gated.status, "completed");
  }
});

test("passed 终态缺少 Tester 或验收证据时拒绝伪造完成", async () => {
  const loop = await passedLoop();
  const forged = {
    ...loop,
    tester: {
      ...loop.tester,
      validation: { ...validation(), acceptanceCriteria: [] }
    }
  };
  assert.throws(
    () => evaluateRepairLoopCompletion({ loop: forged, evidence: evidence(), finalContent: "已完成。" }),
    /完整验收条件映射/
  );
});

// 保证测试夹具始终满足统一 CompletionEvidence 的其余字段，避免 Graph 自创证据协议。
const _completionEvidenceCompatibility: CompletionEvidence = {
  ...evidence(),
  mutationExpected: true,
  changedFileCount: 1,
  validationStatus: "passed"
};
void _completionEvidenceCompatibility;
