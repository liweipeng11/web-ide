import test from "node:test";
import assert from "node:assert/strict";
import type { AgentContext, AgentState, AgentTaskPacket } from "../../runtime/contracts.js";
import type { VerificationReport } from "../../verifier/types.js";
import { TesterAgent } from "./testerAgent.js";

function createTask(overrides: Partial<AgentTaskPacket> = {}): AgentTaskPacket {
  return {
    taskId: "T3",
    goal: "验证认证限流",
    context: {
      changedFiles: ["src/auth.ts"],
      testScope: ["tests/auth/**"],
      acceptanceEvidence: [{ criterion: "第 6 次登录返回 429", testFiles: ["tests/auth/rate-limit.test.ts"] }]
    },
    constraints: [],
    acceptanceCriteria: ["第 6 次登录返回 429"],
    readScope: ["src/**", "tests/**", "package.json"],
    writeScope: [],
    allowedTools: ["run_verification"],
    ...overrides
  };
}

function createReport(status: VerificationReport["status"], options: { includeTest?: boolean; failed?: boolean } = {}): VerificationReport {
  const includeTest = options.includeTest ?? true;
  const resultStatus = options.failed ? "failed" as const : "success" as const;
  const execution = includeTest ? {
    command: { name: "test", command: "pnpm test", source: "package.json", reason: "测试", stage: "test" as const },
    policy: { level: "safe" as const, reason: "允许" },
    result: {
      id: "cmd-1",
      command: "pnpm test",
      cwd: "C:/workspace",
      status: resultStatus,
      exitCode: options.failed ? 1 : 0,
      stdout: "",
      stderr: options.failed ? "expected 429, actual 401" : "",
      summary: "",
      startedAt: "2026-08-11T00:00:00.000Z",
      finishedAt: "2026-08-11T00:00:01.000Z"
    },
    issues: options.failed ? [{ category: "test" as const, message: "expected 429, actual 401" }] : []
  } : null;
  const executions = execution ? [execution] : [];
  return {
    status,
    plannedCommands: execution ? [execution.command] : [],
    plan: {
      mode: "incremental",
      commands: execution ? [execution.command] : [],
      changedFiles: ["src/auth.ts"],
      affectedPackages: [""],
      relatedTests: includeTest ? ["tests/auth/rate-limit.test.ts"] : [],
      buildRequired: false,
      reasons: [],
      diagnostics: []
    },
    executions,
    ...(options.failed && execution ? { failedExecution: execution } : {})
  };
}

function createContext(report: VerificationReport): AgentContext {
  const state: AgentState = {
    goal: "验证认证限流",
    currentTask: "T3",
    completedTasks: ["T1", "T2"],
    failedTasks: [],
    changedFiles: ["src/auth.ts"],
    facts: [],
    status: "running"
  };
  return {
    agentId: "tester",
    state,
    getState: () => state,
    availableTools: [{ name: "run_verification", description: "verify", effect: "execute" }],
    callTool: async (tool, args) => {
      assert.equal(tool, "run_verification");
      assert.deepEqual(args, { changedFiles: ["src/auth.ts"], testScope: ["tests/auth/**"] });
      return report;
    }
  };
}

test("Tester 根据真实测试成功结果报告验收通过", async () => {
  const result = await new TesterAgent().run(createTask(), createContext(createReport("success")));

  assert.equal(result.status, "success");
  assert.equal(result.validation.status, "passed");
  assert.equal(result.validation.checks.test?.[0].status, "passed");
  assert.equal(result.validation.acceptanceCriteria[0].status, "passed");
  assert.deepEqual(result.changedFiles, []);
});

test("Tester 将测试失败转换为结构化失败证据且不修改文件", async () => {
  const result = await new TesterAgent().run(createTask(), createContext(createReport("failed", { failed: true })));

  assert.equal(result.status, "failed");
  assert.equal(result.validation.status, "failed");
  assert.equal(result.validation.failures[0].category, "test");
  assert.match(result.validation.failures[0].message, /429/);
  assert.deepEqual(result.changedFiles, []);
});

test("验证流水线未执行测试时 Tester 不伪装成业务验收通过", async () => {
  const result = await new TesterAgent().run(createTask(), createContext(createReport("success", { includeTest: false })));

  assert.equal(result.status, "blocked");
  assert.equal(result.validation.acceptanceCriteria[0].status, "not_verified");
  assert.match(result.blockers[0], /没有执行成功的测试/);
});

test("测试通过但验收条件缺少明确文件映射时仍保持未验证", async () => {
  const task = createTask({ context: { changedFiles: ["src/auth.ts"], testScope: ["tests/auth/**"], acceptanceEvidence: [] } });
  const context = createContext(createReport("success"));
  context.callTool = async () => createReport("success");
  const result = await new TesterAgent().run(task, context);

  assert.equal(result.status, "blocked");
  assert.equal(result.validation.acceptanceCriteria[0].status, "not_verified");
});

test("Tester 拒绝写范围和缺失的验证工具授权", async () => {
  const agent = new TesterAgent();
  await assert.rejects(
    () => agent.run(createTask({ writeScope: ["src/**"] }), createContext(createReport("success"))),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );
  await assert.rejects(
    () => agent.run(createTask({ allowedTools: [] }), createContext(createReport("success"))),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "PERMISSION_DENIED")
  );
});

test("Tester 拒绝 testScope 外的验收证据文件", async () => {
  const task = createTask({
    context: {
      changedFiles: ["src/auth.ts"],
      testScope: ["tests/auth/**"],
      acceptanceEvidence: [{ criterion: "第 6 次登录返回 429", testFiles: ["tests/payment/payment.test.ts"] }]
    }
  });
  await assert.rejects(
    () => new TesterAgent().run(task, createContext(createReport("success"))),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "SCOPE_VIOLATION")
  );
});
