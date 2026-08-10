import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, AgentTaskPacket, Plan } from "./contracts.js";
import type { AgentContext as LegacyAgentContext, AgentToolDefinition } from "../agentToolTypes.js";
import { createAgentToolRuntime } from "../agentTools.js";
import { AgentRegistry } from "./agentRegistry.js";
import { adaptLegacyAgentTool } from "./legacyToolAdapter.js";
import { PermissionManager } from "./permissionManager.js";
import { RuntimeKernel } from "./runtimeKernel.js";
import { createAgentState, StateManager } from "./stateManager.js";
import { ToolRegistry } from "./toolRegistry.js";

const legacyAgentContext: LegacyAgentContext = {
  userGoal: "读取入口",
  filesRead: [],
  searchQueries: [],
  searchResultFiles: [],
  relevantFiles: [],
  patternSearchPerformed: false,
  patternCandidateFiles: [],
  existenceCheckPerformed: false,
  unresolvedExistenceChecks: [],
  commandsRun: [],
  externalSources: []
};

function createPlan(): Plan {
  return {
    version: 1,
    goal: "验证旧工具适配",
    assumptions: [],
    completionCriteria: ["旧工具通过新 Runtime 执行"],
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "读取入口",
      dependencies: [],
      requiredCapabilities: ["read"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["返回入口内容"],
      status: "pending"
    }]
  };
}

const task: AgentTaskPacket = {
  taskId: "T1",
  goal: "读取入口",
  context: null,
  constraints: ["只读"],
  acceptanceCriteria: ["返回入口内容"],
  readScope: ["src/**"],
  writeScope: [],
  allowedTools: ["legacyReadFile"]
};

test("现有 AgentToolDefinition 可通过新 Runtime 的权限边界执行", async () => {
  let executionCount = 0;
  const legacyTool: AgentToolDefinition = {
    name: "legacyReadFile",
    description: "旧版读取工具",
    parameters: { type: "object", properties: { filePath: { type: "string" } } },
    async execute(args, runtime) {
      executionCount += 1;
      runtime.agentContext.filesRead.push(String(args.filePath));
      return { filePath: args.filePath, content: "export const app = true" };
    },
    summarize(result, cached) {
      return { cached, ...(result as Record<string, unknown>) };
    }
  };
  const adaptedTool = adaptLegacyAgentTool(legacyTool, {
    effect: "read",
    getTargetPaths: (args) => [String(args.filePath)],
    createRuntime: () => createAgentToolRuntime({ agentContext: legacyAgentContext, runId: "runtime-integration" })
  });
  const explorer: Agent = {
    id: "explorer",
    capabilities: ["read"],
    async run(packet, context) {
      const result = await context.callTool("legacyReadFile", { filePath: "src/index.ts" });
      return {
        taskId: packet.taskId,
        status: "success",
        summary: "读取完成",
        facts: [JSON.stringify(result)],
        changedFiles: [],
        evidence: ["src/index.ts"],
        blockers: []
      };
    }
  };
  const kernel = new RuntimeKernel({
    agents: new AgentRegistry([explorer]),
    tools: new ToolRegistry([adaptedTool]),
    permissions: new PermissionManager([{ agentId: "explorer", allowedTools: ["legacyReadFile"] }]),
    state: new StateManager(createAgentState("验证旧工具适配", createPlan()))
  });

  const result = await kernel.execute("explorer", task);
  assert.equal(result.result.status, "success");
  assert.equal(executionCount, 1);
  assert.deepEqual(legacyAgentContext.filesRead, ["src/index.ts"]);
});

test("新 Runtime 在旧写工具执行前拦截范围越权", async () => {
  let executionCount = 0;
  const legacyWriteTool: AgentToolDefinition = {
    name: "legacyWriteFile",
    description: "旧版写入工具",
    parameters: { type: "object", properties: { filePath: { type: "string" } } },
    async execute() {
      executionCount += 1;
      return { changed: true, filePath: "src/index.ts" };
    },
    summarize(result) {
      return result;
    }
  };
  const adaptedTool = adaptLegacyAgentTool(legacyWriteTool, {
    effect: "write",
    getTargetPaths: (args) => [String(args.filePath)],
    createRuntime: () => createAgentToolRuntime({ agentContext: legacyAgentContext, runId: "runtime-write-integration" })
  });
  const explorer: Agent = {
    id: "explorer",
    capabilities: ["read"],
    async run(packet, context) {
      await context.callTool("legacyWriteFile", { filePath: "src/index.ts" });
      return { taskId: packet.taskId, status: "success", summary: "", facts: [], changedFiles: [], evidence: [], blockers: [] };
    }
  };
  const kernel = new RuntimeKernel({
    agents: new AgentRegistry([explorer]),
    tools: new ToolRegistry([adaptedTool]),
    permissions: new PermissionManager([{ agentId: "explorer", allowedTools: ["legacyWriteFile"] }]),
    state: new StateManager(createAgentState("验证旧工具适配", createPlan()))
  });

  const result = await kernel.execute("explorer", { ...task, allowedTools: ["legacyWriteFile"] });
  assert.equal(result.result.status, "failed");
  assert.equal(executionCount, 0);
  assert.match(result.result.blockers[0], /范围之外/);
});
