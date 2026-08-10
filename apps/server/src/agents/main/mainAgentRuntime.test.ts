import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeTool } from "../../runtime/contracts.js";
import { MainAgent } from "./mainAgent.js";
import type { MainAgentDecisionModel } from "./mainAgentModel.js";
import { MainAgentRuntime } from "./mainAgentRuntime.js";

class RuntimeDecisionModel implements MainAgentDecisionModel {
  routeCalls = 0;

  constructor(
    private readonly routeValue: unknown,
    private readonly actions: unknown[]
  ) {}

  async route() {
    this.routeCalls += 1;
    return this.routeValue;
  }

  async nextAction() {
    return this.actions.shift();
  }
}

test("正式入口只执行一次路由并完成 direct 请求", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] },
    [{ type: "respond", content: "直接回答" }, { type: "finish" }]
  );
  const runtime = new MainAgentRuntime({ agent: new MainAgent(model) });
  const result = await runtime.execute({ goal: "解释这个函数" });

  assert.equal(model.routeCalls, 1);
  assert.equal(result.decision.route, "direct");
  assert.equal(result.execution.result.status, "success");
  assert.equal(result.execution.result.summary, "直接回答");
});

test("正式入口从写工具结果同步 changedFiles 到 Result 和 State", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "medium", route: "main_loop", requiredCapabilities: ["read", "edit"] },
    [
      { type: "tool", tool: "edit_file", args: { filePath: "src/auth.ts" } },
      { type: "respond", content: "已修改超时时间。" },
      { type: "finish" }
    ]
  );
  const editTool: RuntimeTool = {
    name: "edit_file",
    description: "编辑文件",
    effect: "write",
    getTargetPaths: (args) => [String(args.filePath)],
    getChangedFiles: (args) => [String(args.filePath)],
    async execute() {
      return { changed: true };
    }
  };
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(model),
    tools: [editTool],
    allowedTools: ["edit_file"]
  });
  const result = await runtime.execute({
    goal: "修改 auth.ts 中的超时时间",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    allowedTools: ["edit_file"],
    acceptanceCriteria: ["auth.ts 已更新"]
  });

  assert.deepEqual(result.execution.result.changedFiles, ["src/auth.ts"]);
  assert.deepEqual(result.execution.state.changedFiles, ["src/auth.ts"]);
  assert.match(result.execution.state.facts[0], /受控写入/);
});

test("只读意图会在正式入口移除写工具和 writeScope", async () => {
  let executionCount = 0;
  const model = new RuntimeDecisionModel(
    { intent: "analysis", complexity: "medium", route: "main_loop", requiredCapabilities: ["read"] },
    [{ type: "tool", tool: "edit_file", args: { filePath: "src/auth.ts" } }]
  );
  const editTool: RuntimeTool = {
    name: "edit_file",
    description: "编辑文件",
    effect: "write",
    getTargetPaths: (args) => [String(args.filePath)],
    getChangedFiles: (args) => [String(args.filePath)],
    async execute() {
      executionCount += 1;
      return { changed: true };
    }
  };
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(model),
    tools: [editTool],
    allowedTools: ["edit_file"]
  });
  const result = await runtime.execute({
    goal: "只分析 auth.ts，不要修改",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    allowedTools: ["edit_file"]
  });

  assert.equal(executionCount, 0);
  assert.equal(result.execution.result.status, "failed");
  assert.deepEqual(result.execution.state.changedFiles, []);
  assert.match(result.execution.result.blockers[0], /不能调用任务未授权的工具/);
});

test("代码修改没有 Runtime 确认的变更文件时不能完成", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "code_change", complexity: "medium", route: "main_loop", requiredCapabilities: ["read", "edit"] },
    [
      { type: "tool", tool: "read_file", args: { filePath: "src/auth.ts" } },
      { type: "respond", content: "已修改。" },
      { type: "finish" }
    ]
  );
  const readTool: RuntimeTool = {
    name: "read_file",
    description: "读取文件",
    effect: "read",
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      return "content";
    }
  };
  const runtime = new MainAgentRuntime({
    agent: new MainAgent(model),
    tools: [readTool],
    allowedTools: ["read_file"]
  });
  const result = await runtime.execute({
    goal: "修改 auth.ts",
    readScope: ["src/auth.ts"],
    writeScope: ["src/auth.ts"],
    allowedTools: ["read_file"]
  });

  assert.equal(result.execution.result.status, "failed");
  assert.match(result.execution.result.blockers[0], /没有经过 Runtime 确认的变更文件/);
});

test("main_loop 未执行工具时不能只靠文字响应完成", async () => {
  const model = new RuntimeDecisionModel(
    { intent: "analysis", complexity: "medium", route: "main_loop", requiredCapabilities: ["read"] },
    [{ type: "respond", content: "分析完成。" }, { type: "finish" }]
  );
  const runtime = new MainAgentRuntime({ agent: new MainAgent(model) });
  const result = await runtime.execute({ goal: "分析 auth.ts" });

  assert.equal(result.execution.result.status, "failed");
  assert.match(result.execution.result.blockers[0], /尚未执行任何受控工具/);
});
