import test from "node:test";
import assert from "node:assert/strict";
import type { AgentContext, AgentState, AgentTaskPacket } from "../../runtime/contracts.js";
import { DeveloperAgent } from "./developerAgent.js";
import type { DeveloperAgentDecisionModel } from "./developerAgentModel.js";

class SequenceModel implements DeveloperAgentDecisionModel {
  readonly prompts: string[] = [];

  constructor(private readonly actions: unknown[]) {}

  async nextAction(input: string) {
    this.prompts.push(input);
    if (!this.actions.length) throw new Error("测试动作已耗尽");
    return this.actions.shift();
  }
}

function createTask(overrides: Partial<AgentTaskPacket> = {}): AgentTaskPacket {
  return {
    taskId: "T2",
    goal: "把认证超时改为 30 秒",
    context: {},
    constraints: ["不能新增依赖"],
    acceptanceCriteria: ["认证超时为 30 秒"],
    readScope: ["src/auth/**"],
    writeScope: ["src/auth/**"],
    allowedTools: ["list_directory", "search_files", "grep", "read_file", "apply_patch", "run_local_check"],
    ...overrides
  };
}

function createContext(callTool: AgentContext["callTool"]): AgentContext {
  const state: AgentState = {
    goal: "修改认证超时",
    currentTask: "T2",
    completedTasks: [],
    failedTasks: [],
    changedFiles: [],
    facts: [],
    status: "running"
  };
  return {
    agentId: "developer",
    state,
    getState: () => state,
    availableTools: [
      { name: "list_directory", description: "list", effect: "read" },
      { name: "search_files", description: "search", effect: "read" },
      { name: "grep", description: "grep", effect: "read" },
      { name: "read_file", description: "read", effect: "read" },
      { name: "apply_patch", description: "patch", effect: "write" },
      { name: "run_local_check", description: "check", effect: "execute" }
    ],
    callTool
  };
}

test("Developer 只根据工具确认的真实变更生成成功结果", async () => {
  const model = new SequenceModel([
    { type: "tool", tool: "read_file", args: { filePath: "src/auth/service.ts" } },
    {
      type: "tool",
      tool: "apply_patch",
      args: {
        operation: "replace",
        filePath: "src/auth/service.ts",
        search: "timeout = 10",
        replace: "timeout = 30"
      }
    },
    {
      type: "finish",
      result: {
        summary: "认证超时已更新",
        facts: ["超时值为 30 秒"],
        evidence: ["src/auth/service.ts"]
      }
    }
  ]);
  const calls: string[] = [];
  const result = await new DeveloperAgent(model).run(createTask(), createContext(async (tool) => {
    calls.push(tool);
    if (tool === "read_file") return { content: "timeout = 10" };
    return { filePath: "src/auth/service.ts", operation: "replace", changed: true, replacements: 1 };
  }));

  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["read_file", "apply_patch"]);
  assert.deepEqual(result.changedFiles, ["src/auth/service.ts"]);
  assert.match(model.prompts[0], /不能新增依赖/);
});

test("Developer 修改已有文件前必须先读取目标文件", async () => {
  const model = new SequenceModel([{
    type: "tool",
    tool: "apply_patch",
    args: { operation: "replace", filePath: "src/auth/service.ts", search: "10", replace: "30" }
  }]);
  await assert.rejects(
    () => new DeveloperAgent(model).run(createTask(), createContext(async () => null)),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );
});

test("Developer 修改后可以运行受控局部检查", async () => {
  const model = new SequenceModel([
    { type: "tool", tool: "read_file", args: { filePath: "src/auth/service.ts" } },
    {
      type: "tool",
      tool: "apply_patch",
      args: { operation: "replace", filePath: "src/auth/service.ts", search: "10", replace: "30" }
    },
    { type: "tool", tool: "run_local_check", args: { command: "pnpm typecheck" } },
    { type: "finish", result: { summary: "修改并检查完成", facts: [], evidence: ["pnpm typecheck"] } }
  ]);
  const calls: string[] = [];
  const result = await new DeveloperAgent(model).run(createTask(), createContext(async (tool) => {
    calls.push(tool);
    if (tool === "read_file") return { content: "timeout = 10" };
    if (tool === "apply_patch") return { filePath: "src/auth/service.ts", operation: "replace", changed: true };
    return { command: "pnpm typecheck", status: "success", exitCode: 0 };
  }));

  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["read_file", "apply_patch", "run_local_check"]);
});

test("Developer 不能在局部检查失败后报告成功", async () => {
  const model = new SequenceModel([
    { type: "tool", tool: "read_file", args: { filePath: "src/auth/service.ts" } },
    {
      type: "tool",
      tool: "apply_patch",
      args: { operation: "replace", filePath: "src/auth/service.ts", search: "10", replace: "30" }
    },
    { type: "tool", tool: "run_local_check", args: { command: "pnpm typecheck" } },
    { type: "finish", result: { summary: "完成", facts: [], evidence: [] } }
  ]);

  await assert.rejects(
    () => new DeveloperAgent(model).run(createTask(), createContext(async (tool) => {
      if (tool === "read_file") return { content: "timeout = 10" };
      if (tool === "apply_patch") return { filePath: "src/auth/service.ts", operation: "replace", changed: true };
      return { command: "pnpm typecheck", status: "failed", exitCode: 1 };
    })),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );
});

test("Developer 没有真实文件变更时不能报告成功", async () => {
  const model = new SequenceModel([{
    type: "finish",
    result: { summary: "完成", facts: [], evidence: [] }
  }]);
  await assert.rejects(
    () => new DeveloperAgent(model).run(createTask(), createContext(async () => null)),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );
});

test("Developer 发现范围不足时返回结构化 scopeChangeRequest", async () => {
  const model = new SequenceModel([{
    type: "request_scope_change",
    reason: "需要同步修改共享中间件",
    requiredScope: ["src/middleware/rate-limit.ts"]
  }]);
  const result = await new DeveloperAgent(model).run(createTask(), createContext(async () => null));

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.scopeChangeRequest?.requiredScope, ["src/middleware/rate-limit.ts"]);
});

test("Developer 的范围申请不能包含工作区逃逸路径", async () => {
  const model = new SequenceModel([{
    type: "request_scope_change",
    reason: "尝试访问工作区外文件",
    requiredScope: ["../secret.txt"]
  }]);
  await assert.rejects(
    () => new DeveloperAgent(model).run(createTask(), createContext(async () => null)),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "SCOPE_VIOLATION")
  );
});

test("Developer 拒绝未授权工具和空 writeScope", async () => {
  const unauthorized = new DeveloperAgent(new SequenceModel([{
    type: "tool",
    tool: "run_command",
    args: { command: "git push" }
  }]));
  await assert.rejects(
    () => unauthorized.run(createTask(), createContext(async () => null)),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "PERMISSION_DENIED")
  );
  await assert.rejects(
    () => new DeveloperAgent(new SequenceModel([])).run(createTask({ writeScope: [] }), createContext(async () => null)),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );
});
