import test from "node:test";
import assert from "node:assert/strict";
import type { AgentContext, AgentState, AgentTaskPacket } from "../../runtime/contracts.js";
import { ExplorerAgent } from "./explorerAgent.js";
import type { ExplorerAgentDecisionModel } from "./explorerAgentModel.js";

class SequenceModel implements ExplorerAgentDecisionModel {
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
    taskId: "T1",
    goal: "找到登录流程",
    context: {},
    constraints: [],
    acceptanceCriteria: ["定位认证入口并给出证据"],
    readScope: ["src/**"],
    writeScope: [],
    allowedTools: ["list_directory", "search_files", "grep", "read_file"],
    ...overrides
  };
}

function createContext(callTool: AgentContext["callTool"]): AgentContext {
  const state: AgentState = {
    goal: "找到登录流程",
    currentTask: "T1",
    completedTasks: [],
    failedTasks: [],
    changedFiles: [],
    facts: [],
    status: "running"
  };
  return {
    agentId: "explorer",
    state,
    getState: () => state,
    availableTools: ["list_directory", "search_files", "grep", "read_file"].map((name) => ({
      name,
      description: name,
      effect: "read" as const
    })),
    callTool
  };
}

test("Explorer 通过只读工具定位仓库事实并返回结构化证据", async () => {
  const model = new SequenceModel([
    { type: "tool", tool: "grep", args: { pattern: "login", path: "src" } },
    {
      type: "finish",
      result: {
        summary: "登录路由调用认证服务",
        relevantFiles: ["src/routes/auth.ts"],
        facts: [{ statement: "login 路由调用 authenticate", evidence: ["src/routes/auth.ts:12"] }],
        unknowns: []
      }
    }
  ]);
  const calls: string[] = [];
  const result = await new ExplorerAgent(model).run(createTask(), createContext(async (tool) => {
    calls.push(tool);
    return { matches: [{ filePath: "src/routes/auth.ts", line: 12, text: "authenticate" }] };
  }));

  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["grep"]);
  assert.deepEqual(result.changedFiles, []);
  assert.deepEqual(result.exploration.relevantFiles, ["src/routes/auth.ts"]);
  assert.deepEqual(result.evidence, ["src/routes/auth.ts:12"]);
  assert.match(model.prompts[1], /routes\/auth\.ts/);
});

test("Explorer 拒绝模型请求未授权的写工具", async () => {
  const model = new SequenceModel([{ type: "tool", tool: "edit_file", args: { filePath: "src/routes/auth.ts" } }]);
  await assert.rejects(
    () => new ExplorerAgent(model).run(createTask(), createContext(async () => null)),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "PERMISSION_DENIED")
  );
});

test("Explorer 超过独立文件读取预算后停止探索", async () => {
  const model = new SequenceModel([
    { type: "tool", tool: "read_file", args: { filePath: "src/a.ts" } },
    { type: "tool", tool: "read_file", args: { filePath: "src/b.ts" } }
  ]);
  await assert.rejects(
    () => new ExplorerAgent(model, 3, 1).run(createTask(), createContext(async () => ({ content: "secret source" }))),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "AGENT_LOOP_LIMIT_EXCEEDED")
  );
});

test("Explorer 最终结果不包含工具读取的原始文件全文", async () => {
  const model = new SequenceModel([
    { type: "tool", tool: "read_file", args: { filePath: "src/routes/auth.ts" } },
    {
      type: "finish",
      result: {
        summary: "已确认入口",
        relevantFiles: ["src/routes/auth.ts"],
        facts: [{ statement: "存在登录入口", evidence: ["src/routes/auth.ts:1"] }],
        unknowns: []
      }
    }
  ]);
  const result = await new ExplorerAgent(model).run(
    createTask(),
    createContext(async () => ({ content: "TOP_SECRET_FULL_FILE_CONTENT", startLine: 1, endLine: 1 }))
  );

  assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET_FULL_FILE_CONTENT/);
});

