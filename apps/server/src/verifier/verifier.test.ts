import assert from "node:assert/strict";
import test from "node:test";
import { createVerifier, executeVerificationPlan, type VerifierDependencies } from "./verifier.js";
import type { CommandResult } from "../types.js";
import type { VerificationCommand } from "./types.js";

function result(command: string, status: "success" | "failed" | "cancelled"): CommandResult {
  return {
    command,
    cwd: "C:/workspace",
    exitCode: status === "cancelled" ? null : status === "success" ? 0 : 1,
    stdout: status === "success" ? "ok" : "",
    stderr: status === "failed" ? "src/app.ts(3,2): error TS1005: ';' expected." : "",
    status,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

function command(name: string, stage: VerificationCommand["stage"]): VerificationCommand {
  return { name, command: `pnpm ${name}`, source: "package.json", reason: `${name} 脚本`, stage };
}

function plan(commands: VerificationCommand[]) {
  return { mode: "full" as const, commands, changedFiles: [], affectedPackages: [], relatedTests: [], buildRequired: true, reasons: [], diagnostics: [] };
}

test("验证流水线在首个失败命令处停止并返回结构化问题", async () => {
  const called: string[] = [];
  const planned = [command("typecheck", "typecheck"), command("test", "test"), command("build", "build")];
  const verifier = createVerifier({
    planVerification: async () => plan(planned),
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    runProjectCommand: async (value) => {
      called.push(value);
      return result(value, value.includes("test") ? "failed" : "success");
    }
  } as VerifierDependencies);

  const report = await verifier({ workspaceRoot: "C:/workspace" });

  assert.equal(report.status, "failed");
  assert.deepEqual(called, ["pnpm typecheck", "pnpm test"]);
  assert.equal(report.failedExecution?.issues[0].file, "src/app.ts");
});

test("验证命令被主动停止时保留取消状态", async () => {
  const verifier = createVerifier({
    planVerification: async () => plan([command("test", "test")]),
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    runProjectCommand: async (value) => result(value, "cancelled")
  } as VerifierDependencies);

  const report = await verifier({ workspaceRoot: "C:/workspace" });

  assert.equal(report.status, "cancelled");
  assert.equal(report.failedExecution?.result?.status, "cancelled");
});

test("未确认的命令不会执行", async () => {
  let called = false;
  const verifier = createVerifier({
    planVerification: async () => plan([command("custom-check", "format_syntax")]),
    evaluateCommandPolicy: () => ({ level: "confirm", reason: "需要确认" }),
    runProjectCommand: async () => {
      called = true;
      return result("custom-check", "success");
    }
  } as VerifierDependencies);

  const report = await verifier({ workspaceRoot: "C:/workspace" });

  assert.equal(report.status, "needs_confirmation");
  assert.equal(called, false);
});

test("所有验证阶段成功后返回完整执行记录", async () => {
  const planned = [command("typecheck", "typecheck"), command("lint", "lint"), command("test", "test"), command("build", "build")];
  const verifier = createVerifier({
    planVerification: async () => plan(planned),
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    runProjectCommand: async (value) => result(value, "success")
  } as VerifierDependencies);

  const report = await verifier({ workspaceRoot: "C:/workspace" });

  assert.equal(report.status, "success");
  assert.deepEqual(report.executions.map((execution) => execution.command.stage), ["typecheck", "lint", "test", "build"]);
});

test("没有可用验证命令时返回明确状态", async () => {
  const verifier = createVerifier({
    planVerification: async () => plan([]),
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    runProjectCommand: async (value) => result(value, "success")
  } as VerifierDependencies);

  const report = await verifier({ workspaceRoot: "C:/workspace" });

  assert.equal(report.status, "no_commands");
  assert.deepEqual(report.executions, []);
});

test("执行冻结计划时不重新规划，并在执行边界重新检查命令策略", async () => {
  let commandCalls = 0;
  const frozen = plan([command("test", "test")]);
  const report = await executeVerificationPlan(frozen, {}, {
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    runProjectCommand: async (value) => {
      commandCalls += 1;
      return result(value, "success");
    }
  });
  assert.equal(report.plan, frozen);
  assert.equal(commandCalls, 1);

  const tightened = await executeVerificationPlan(frozen, {}, {
    evaluateCommandPolicy: () => ({ level: "blocked", reason: "策略已收紧" }),
    runProjectCommand: async () => {
      throw new Error("策略阻止后不应执行命令");
    }
  });
  assert.equal(tightened.status, "blocked");
});
