import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "../runtime/agentRegistry.js";
import type { Agent, AgentTaskPacket, Plan } from "../runtime/contracts.js";
import { PermissionManager } from "../runtime/permissionManager.js";
import { RuntimeKernel } from "../runtime/runtimeKernel.js";
import { createAgentState, StateManager } from "../runtime/stateManager.js";
import { ToolRegistry } from "../runtime/toolRegistry.js";

test("阶段 8：瞬时失败在预算内恢复并产出可审计诊断", async () => {
  const plan: Plan = {
    version: 1,
    goal: "稳定完成仓库探索",
    assumptions: [],
    tasks: [{
      id: "E1",
      type: "explore",
      goal: "读取仓库事实",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope: ["src/**"],
      writeScope: [],
      acceptanceCriteria: ["返回仓库事实"],
      status: "pending"
    }],
    completionCriteria: ["返回仓库事实"]
  };
  const packet: AgentTaskPacket = {
    taskId: "E1",
    goal: "读取仓库事实",
    context: {},
    constraints: [],
    acceptanceCriteria: ["返回仓库事实"],
    readScope: ["src/**"],
    writeScope: [],
    allowedTools: []
  };
  let calls = 0;
  const agent: Agent = {
    id: "explorer",
    capabilities: ["exploration"],
    async run(task) {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("temporary network error"), { retryable: true });
      return {
        taskId: task.taskId,
        status: "success",
        summary: "已恢复并完成探索",
        facts: ["Runtime 已确认结果"],
        changedFiles: [],
        evidence: ["mock:1"],
        blockers: []
      };
    }
  };
  const runtime = new RuntimeKernel({
    agents: new AgentRegistry([agent]),
    tools: new ToolRegistry([]),
    permissions: new PermissionManager([{ agentId: agent.id, allowedTools: [] }]),
    state: new StateManager(createAgentState(plan.goal, plan)),
    executionPolicy: { timeoutMs: 100, maxAttempts: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 0 }
  });

  const execution = await runtime.execute(agent.id, packet);

  assert.equal(execution.result.status, "success");
  assert.equal(execution.state.status, "completed");
  assert.equal(execution.diagnostics?.attempts, 2);
  assert.equal(execution.diagnostics?.retries, 1);
  assert.equal(execution.diagnostics?.failureCategory, "none");
});
