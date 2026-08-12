import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, AgentTaskPacket, Plan, RuntimeTool } from "./contracts.js";
import { AgentRegistry } from "./agentRegistry.js";
import { PermissionManager } from "./permissionManager.js";
import { RuntimeKernel } from "./runtimeKernel.js";
import { createAgentState, StateManager } from "./stateManager.js";
import { ToolRegistry } from "./toolRegistry.js";

function createPlan(): Plan {
  return {
    version: 1,
    goal: "探索代码库",
    assumptions: [],
    completionCriteria: ["已确认入口"],
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "读取入口文件",
      dependencies: [],
      requiredCapabilities: ["read"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["返回入口事实"],
      status: "pending"
    }]
  };
}

function createTask(overrides: Partial<AgentTaskPacket> = {}): AgentTaskPacket {
  return {
    taskId: "T1",
    goal: "读取入口文件",
    context: null,
    constraints: ["只读"],
    acceptanceCriteria: ["返回入口事实"],
    readScope: ["src/**"],
    writeScope: [],
    allowedTools: ["read_file"],
    ...overrides
  };
}

function createKernel(agent: Agent, tools: RuntimeTool[], allowedTools: string[]) {
  return new RuntimeKernel({
    agents: new AgentRegistry([agent]),
    tools: new ToolRegistry(tools),
    permissions: new PermissionManager([{ agentId: agent.id, allowedTools }]),
    state: new StateManager(createAgentState("探索代码库", createPlan()))
  });
}

test("RuntimeKernel 执行 Fake Agent、调用受控工具并更新状态", async () => {
  let executionCount = 0;
  const readTool: RuntimeTool = {
    name: "read_file",
    description: "读取文件",
    effect: "read",
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      executionCount += 1;
      return "export const app = true";
    }
  };
  const explorer: Agent = {
    id: "explorer",
    capabilities: ["read"],
    async run(task, context) {
      const content = await context.callTool("read_file", { filePath: "src/index.ts" });
      return {
        taskId: task.taskId,
        status: "success",
        summary: "已读取入口",
        facts: [`入口内容：${content}`],
        changedFiles: [],
        evidence: ["src/index.ts"],
        blockers: []
      };
    }
  };

  const result = await createKernel(explorer, [readTool], ["read_file"]).execute("explorer", createTask());
  assert.equal(executionCount, 1);
  assert.equal(result.result.status, "success");
  assert.equal(result.state.status, "completed");
  assert.deepEqual(result.state.completedTasks, ["T1"]);
});

test("RuntimeKernel 将 Agent 的越权工具调用转换为统一失败结果", async () => {
  let executionCount = 0;
  const editTool: RuntimeTool = {
    name: "edit_file",
    description: "编辑文件",
    effect: "write",
    getTargetPaths: (args) => [String(args.filePath)],
    async execute() {
      executionCount += 1;
      return { changed: true };
    }
  };
  const explorer: Agent = {
    id: "explorer",
    capabilities: ["read"],
    async run(task, context) {
      await context.callTool("edit_file", { filePath: "src/index.ts" });
      return { taskId: task.taskId, status: "success", summary: "", facts: [], changedFiles: [], evidence: [], blockers: [] };
    }
  };

  const result = await createKernel(explorer, [editTool], ["read_file"]).execute(
    "explorer",
    createTask({ allowedTools: ["read_file", "edit_file"] })
  );
  assert.equal(executionCount, 0);
  assert.equal(result.result.status, "failed");
  assert.match(result.result.summary, /无权调用工具/);
  assert.match(result.result.blockers[0], /无权调用工具/);
  assert.deepEqual(result.state.failedTasks, ["T1"]);
});

test("RuntimeKernel 拒绝通过 TaskPacket 扩大 Plan 的写入范围", async () => {
  const explorer: Agent = {
    id: "explorer",
    capabilities: ["read"],
    async run(task) {
      return { taskId: task.taskId, status: "success", summary: "", facts: [], changedFiles: [], evidence: [], blockers: [] };
    }
  };
  const kernel = createKernel(explorer, [], []);

  await assert.rejects(
    () => kernel.execute("explorer", createTask({ writeScope: ["src/**"] })),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_CONTRACT"
  );
});

test("RuntimeKernel 将不符合统一契约的 Agent 输出转换为失败结果", async () => {
  const invalidAgent: Agent = {
    id: "explorer",
    capabilities: ["read"],
    async run(task) {
      return {
        taskId: task.taskId,
        status: "success",
        summary: "格式错误",
        facts: null,
        changedFiles: [],
        evidence: [],
        blockers: []
      } as unknown as Awaited<ReturnType<Agent["run"]>>;
    }
  };

  const result = await createKernel(invalidAgent, [], []).execute("explorer", createTask({ allowedTools: [] }));
  assert.equal(result.result.status, "failed");
  assert.match(result.result.blockers[0], /AgentResult\.facts/);
});
