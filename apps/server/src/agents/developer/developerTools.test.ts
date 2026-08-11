import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeToolExecutionContext } from "../../runtime/contracts.js";
import type { CommandResult } from "../../types.js";
import { createDeveloperRuntimeTools } from "./developerTools.js";

function commandResult(command: string): CommandResult {
  return {
    command,
    cwd: "C:/workspace/apps/server",
    exitCode: 0,
    stdout: "检查通过",
    stderr: "",
    summary: "检查通过",
    status: "success",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString()
  };
}

const context: RuntimeToolExecutionContext = {
  agentId: "developer",
  task: {
    taskId: "T2",
    goal: "修改认证服务",
    context: {},
    constraints: [],
    acceptanceCriteria: ["修改完成"],
    readScope: ["src/auth/**"],
    writeScope: ["src/auth/**"],
    allowedTools: ["run_local_check"]
  }
};

test("Developer 局部检查只执行安全的格式、类型和 lint 包脚本", async () => {
  const calls: Array<{ command: string; cwd?: string }> = [];
  const tools = createDeveloperRuntimeTools({
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    async runProjectCommand(command, cwd) {
      calls.push({ command, cwd });
      return commandResult(command);
    }
  });
  const tool = tools.find((item) => item.name === "run_local_check");
  assert.ok(tool);

  const result = await tool.execute({ command: "pnpm --dir apps/server typecheck" }, context);

  assert.deepEqual(calls, [{ command: "pnpm --dir apps/server typecheck", cwd: undefined }]);
  assert.deepEqual(result, {
    command: "pnpm --dir apps/server typecheck",
    cwd: "C:/workspace/apps/server",
    status: "success",
    exitCode: 0,
    summary: "检查通过",
    output: "检查通过",
    outputTruncated: false
  });
});

test("Developer 局部检查拒绝测试、写入式格式化和任意 Shell", async () => {
  let executions = 0;
  const tools = createDeveloperRuntimeTools({
    evaluateCommandPolicy: () => ({ level: "safe", reason: "测试白名单" }),
    async runProjectCommand(command) {
      executions += 1;
      return commandResult(command);
    }
  });
  const tool = tools.find((item) => item.name === "run_local_check");
  assert.ok(tool);

  for (const command of ["pnpm test", "pnpm format", "git push", "pnpm typecheck; git push"]) {
    await assert.rejects(
      () => tool.execute({ command }, context),
      (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "PERMISSION_DENIED")
    );
  }
  assert.equal(executions, 0);
});

test("Developer 局部检查不会自动批准 confirm 级命令", async () => {
  let executions = 0;
  const tools = createDeveloperRuntimeTools({
    evaluateCommandPolicy: () => ({ level: "confirm", reason: "需要确认" }),
    async runProjectCommand(command) {
      executions += 1;
      return commandResult(command);
    }
  });
  const tool = tools.find((item) => item.name === "run_local_check");
  assert.ok(tool);

  await assert.rejects(
    () => tool.execute({ command: "pnpm lint" }, context),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "PERMISSION_DENIED")
  );
  assert.equal(executions, 0);
});
