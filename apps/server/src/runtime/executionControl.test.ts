import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry } from "./agentRegistry.js";
import type { Agent, AgentTaskPacket, Plan } from "./contracts.js";
import { runControlled } from "./executionControl.js";
import { AgentRuntimeError } from "./errors.js";
import { PermissionManager } from "./permissionManager.js";
import { RuntimeKernel } from "./runtimeKernel.js";
import { createAgentState, StateManager } from "./stateManager.js";
import { ToolRegistry } from "./toolRegistry.js";

const plan: Plan = {
  version: 1,
  goal: "验证稳定执行",
  assumptions: [],
  completionCriteria: ["任务返回稳定结果"],
  tasks: [{
    id: "T1",
    type: "explore",
    goal: "执行瞬时请求",
    dependencies: [],
    requiredCapabilities: ["exploration"],
    readScope: ["src/**"],
    writeScope: [],
    acceptanceCriteria: ["请求成功"],
    status: "pending"
  }]
};

const packet: AgentTaskPacket = {
  taskId: "T1",
  goal: "执行瞬时请求",
  context: {},
  constraints: [],
  acceptanceCriteria: ["请求成功"],
  readScope: ["src/**"],
  writeScope: [],
  allowedTools: []
};

function kernelFor(agent: Agent, executionPolicy: { timeoutMs: number; maxAttempts: number; retryBaseDelayMs: number; retryMaxDelayMs: number }) {
  return new RuntimeKernel({
    agents: new AgentRegistry([agent]),
    tools: new ToolRegistry([]),
    permissions: new PermissionManager([{ agentId: agent.id, allowedTools: [] }]),
    state: new StateManager(createAgentState(plan.goal, plan)),
    executionPolicy
  });
}

test("受控执行超时会中止底层信号并及时返回", async () => {
  let aborted = false;
  await assert.rejects(
    () => runControlled({
      timeoutMs: 10,
      operation: (signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true });
      })
    }),
    (error: unknown) => error instanceof AgentRuntimeError && error.code === "AGENT_TIMEOUT"
  );
  assert.equal(aborted, true);
});

test("Runtime 只重试未产生副作用的瞬时错误", async () => {
  let attempts = 0;
  const agent: Agent = {
    id: "explorer",
    capabilities: ["exploration"],
    async run(task) {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("temporary network failure"), { retryable: true });
      return { taskId: task.taskId, status: "success", summary: "已恢复", facts: [], changedFiles: [], evidence: [], blockers: [] };
    }
  };
  const execution = await kernelFor(agent, { timeoutMs: 100, maxAttempts: 2, retryBaseDelayMs: 0, retryMaxDelayMs: 0 })
    .execute(agent.id, packet);
  assert.equal(execution.result.status, "success");
  assert.equal(execution.diagnostics?.attempts, 2);
  assert.equal(execution.diagnostics?.retries, 1);
});

test("用户取消不会重试", async () => {
  let attempts = 0;
  const controller = new AbortController();
  const agent: Agent = {
    id: "explorer",
    capabilities: ["exploration"],
    async run(_task, context) {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      });
    }
  };
  setTimeout(() => controller.abort(), 5);
  const execution = await kernelFor(agent, { timeoutMs: 100, maxAttempts: 3, retryBaseDelayMs: 0, retryMaxDelayMs: 0 })
    .execute(agent.id, packet, { signal: controller.signal });
  assert.equal(execution.result.status, "failed");
  assert.equal(execution.diagnostics?.failureCategory, "cancelled");
  assert.equal(attempts, 1);
});
