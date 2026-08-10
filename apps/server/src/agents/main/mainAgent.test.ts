import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskPacket, Plan, RuntimeTool } from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import { MainAgent, MAX_MAIN_AGENT_STEPS } from "./mainAgent.js";
import type { MainAgentDecisionModel } from "./mainAgentModel.js";

class FakeDecisionModel implements MainAgentDecisionModel {
  actionCalls = 0;

  constructor(
    private readonly routeValue: unknown,
    private readonly actions: unknown[] | (() => unknown) = []
  ) {}

  async route() {
    if (this.routeValue instanceof Error) throw this.routeValue;
    return this.routeValue;
  }

  async nextAction() {
    this.actionCalls += 1;
    if (typeof this.actions === "function") return this.actions();
    const action = this.actions.shift();
    if (action instanceof Error) throw action;
    return action;
  }
}

function createPlan(goal: string, requiredCapabilities: string[] = []): Plan {
  return {
    version: 1,
    goal,
    assumptions: [],
    completionCriteria: ["Main Agent 返回统一结果"],
    tasks: [{
      id: "T1",
      type: "respond",
      goal,
      dependencies: [],
      requiredCapabilities,
      readScope: ["src/**"],
      writeScope: ["src/**"],
      acceptanceCriteria: ["请求得到处理"],
      status: "pending"
    }]
  };
}

function createTask(goal: string, allowedTools: string[] = []): AgentTaskPacket {
  return {
    taskId: "T1",
    goal,
    context: null,
    constraints: [],
    acceptanceCriteria: ["请求得到处理"],
    readScope: ["src/**"],
    writeScope: ["src/**"],
    allowedTools
  };
}

function createKernel(agent: MainAgent, goal: string, options: {
  tools?: RuntimeTool[];
  allowedTools?: string[];
  requiredCapabilities?: string[];
} = {}) {
  return new RuntimeKernel({
    agents: new AgentRegistry([agent]),
    tools: new ToolRegistry(options.tools ?? []),
    permissions: new PermissionManager([{
      agentId: agent.id,
      allowedTools: options.allowedTools ?? []
    }]),
    state: new StateManager(createAgentState(goal, createPlan(goal, options.requiredCapabilities)))
  });
}

test("Main Agent 将简单问题路由到 direct", async () => {
  const main = new MainAgent(new FakeDecisionModel(new Error("offline")));
  const result = await main.route("解释一下这个函数");

  assert.equal(result.intent, "question");
  assert.equal(result.complexity, "simple");
  assert.equal(result.route, "direct");
  assert.deepEqual(result.requiredCapabilities, []);
});

test("Main Agent 将小范围代码修改路由到 main_loop", async () => {
  const main = new MainAgent(new FakeDecisionModel(new Error("offline")));
  const result = await main.route("把 auth.ts 的 timeout 改成 30 秒");

  assert.equal(result.intent, "code_change");
  assert.equal(result.complexity, "medium");
  assert.equal(result.route, "main_loop");
  assert.deepEqual(result.requiredCapabilities, ["read", "edit"]);
});

test("Main Agent 将大型迁移路由到 planned", async () => {
  const main = new MainAgent(new FakeDecisionModel(new Error("offline")));
  const result = await main.route("把整个 session 认证迁移到 JWT，并保证 API 兼容");

  assert.equal(result.intent, "code_change");
  assert.equal(result.complexity, "complex");
  assert.equal(result.route, "planned");
  assert.deepEqual(result.requiredCapabilities, ["planning", "exploration", "editing", "testing"]);
});

test("显式只读约束不会被模型升级为代码修改", async () => {
  const main = new MainAgent(new FakeDecisionModel({
    intent: "code_change",
    complexity: "medium",
    route: "main_loop",
    requiredCapabilities: ["read", "edit"]
  }));
  const result = await main.route("只分析登录报错，不要修改代码");

  assert.equal(result.intent, "debug");
  assert.deepEqual(result.requiredCapabilities, ["read"]);
});

test("direct 请求直接响应且不调用工具", async () => {
  const goal = "解释一下这个函数";
  const model = new FakeDecisionModel(
    { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] },
    [{ type: "respond", content: "这是一个示例函数。" }, { type: "finish" }]
  );
  const main = new MainAgent(model);
  const result = await createKernel(main, goal).execute("main", createTask(goal));

  assert.equal(result.result.status, "success");
  assert.equal(result.result.summary, "这是一个示例函数。");
  assert.equal(model.actionCalls, 2);
});

test("main_loop 通过 Runtime 权限边界执行工具并消费观察结果", async () => {
  const goal = "检查 src/index.ts 的入口";
  let executionCount = 0;
  const readTool: RuntimeTool = {
    name: "read_file",
    description: "读取文件",
    effect: "read",
    inputSchema: { type: "object", properties: { filePath: { type: "string" } } },
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      executionCount += 1;
      return { content: "export const app = true" };
    }
  };
  const model = new FakeDecisionModel(
    { intent: "analysis", complexity: "medium", route: "main_loop", requiredCapabilities: ["read"] },
    [
      { type: "tool", tool: "read_file", args: { filePath: "src/index.ts" } },
      { type: "respond", content: "已确认入口文件。" },
      { type: "finish" }
    ]
  );
  const main = new MainAgent(model);
  const result = await createKernel(main, goal, {
    tools: [readTool],
    allowedTools: ["read_file"],
    requiredCapabilities: ["read"]
  }).execute("main", createTask(goal, ["read_file"]));

  assert.equal(executionCount, 1);
  assert.equal(result.result.status, "success");
  assert.deepEqual(result.result.evidence, ["tool:read_file"]);
});

test("finish 前必须先生成明确响应", async () => {
  const goal = "解释一下这个函数";
  const model = new FakeDecisionModel(
    { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] },
    [{ type: "finish" }]
  );
  const result = await createKernel(new MainAgent(model), goal).execute("main", createTask(goal));

  assert.equal(result.result.status, "failed");
  assert.match(result.result.blockers[0], /必须先生成 respond action/);
});

test("direct 路由不能通过 NextAction 绕过工具限制", async () => {
  const goal = "解释一下这个函数";
  const model = new FakeDecisionModel(
    { intent: "question", complexity: "simple", route: "direct", requiredCapabilities: [] },
    [{ type: "tool", tool: "read_file", args: { filePath: "src/index.ts" } }]
  );
  const main = new MainAgent(model);
  const readTool: RuntimeTool = {
    name: "read_file",
    description: "读取文件",
    effect: "read",
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      throw new Error("不应执行");
    }
  };
  const result = await createKernel(main, goal, {
    tools: [readTool],
    allowedTools: ["read_file"]
  }).execute("main", createTask(goal, ["read_file"]));

  assert.equal(result.result.status, "failed");
  assert.match(result.result.blockers[0], /direct 路由不能调用工具/);
});

test("阶段 1 识别 planned 路由但不伪造 Planner 执行", async () => {
  const goal = "重构整个认证系统";
  const model = new FakeDecisionModel({
    intent: "code_change",
    complexity: "complex",
    route: "planned",
    requiredCapabilities: ["planning", "exploration", "editing", "testing"]
  });
  const main = new MainAgent(model);
  const result = await createKernel(main, goal).execute("main", createTask(goal));

  assert.equal(result.result.status, "blocked");
  assert.match(result.result.blockers[0], /尚未接入 Planner/);
  assert.equal(model.actionCalls, 0);
});

test("Main Loop 超过 30 步后以稳定错误终止", async () => {
  const goal = "持续检查入口";
  let executionCount = 0;
  const model = new FakeDecisionModel(
    { intent: "analysis", complexity: "medium", route: "main_loop", requiredCapabilities: ["read"] },
    () => ({ type: "tool", tool: "read_file", args: { filePath: "src/index.ts" } })
  );
  const main = new MainAgent(model);
  const readTool: RuntimeTool = {
    name: "read_file",
    description: "读取文件",
    effect: "read",
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      executionCount += 1;
      return "ok";
    }
  };
  const result = await createKernel(main, goal, {
    tools: [readTool],
    allowedTools: ["read_file"],
    requiredCapabilities: ["read"]
  }).execute("main", createTask(goal, ["read_file"]));

  assert.equal(executionCount, MAX_MAIN_AGENT_STEPS);
  assert.equal(result.result.status, "failed");
  assert.match(result.result.blockers[0], /超过最大执行步数 30/);
});
