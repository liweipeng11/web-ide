import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setWorkspaceRoot } from "../../workspaceStore.js";
import { createAgentState } from "../../runtime/stateManager.js";
import { PlannerAgent } from "./plannerAgent.js";
import type { PlannerAgentDecisionModel } from "./plannerAgentModel.js";
import { PlannerAgentRuntime } from "./plannerAgentRuntime.js";

class ToolAwarePlannerModel implements PlannerAgentDecisionModel {
  readonly prompts: string[] = [];

  async createPlan() {
    throw new Error("Runtime 应通过 nextAction 执行 Planner。");
  }

  async replan() {
    throw new Error("本测试不执行重规划。");
  }

  async nextAction(input: string) {
    this.prompts.push(input);
    if (this.prompts.length === 1) {
      return { type: "tool", tool: "read_file", args: { filePath: "src/router.ts", startLine: 1 } };
    }
    return {
      status: "ready",
      plan: {
        assumptions: [],
        tasks: [{ id: "T1", type: "implement", goal: "补充登录路由", dependencies: [], acceptanceCriteria: ["路由已定义"] }],
        completionCriteria: ["登录路由已定义"]
      }
    };
  }
}

test("Planner Runtime 可调用受限只读工具并将观察结果带回规划模型", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const model = new ToolAwarePlannerModel();
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "补充登录路由",
      knownFacts: [],
      constraints: [],
      readScope: ["src/**"],
      writeScope: ["src/**"],
      state: createAgentState("补充登录路由")
    });

    assert.equal(result.status, "ready");
    assert.equal(model.prompts.length, 2);
    assert.match(model.prompts[0], /read_file/);
    assert.match(model.prompts[1], /loginRoute/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner 兼容缺少 type 字段的只读工具动作", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-implicit-tool-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const actions: unknown[] = [
      { tool: "read_file", args: { filePath: "src/router.ts" } },
      {
        status: "ready",
        plan: {
          assumptions: [],
          tasks: [{ id: "T1", type: "implement", goal: "补充登录路由", dependencies: [], acceptanceCriteria: ["路由已定义"] }],
          completionCriteria: ["登录路由已定义"]
        }
      }
    ];
    const prompts: string[] = [];
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction(input: string) { prompts.push(input); return actions.shift(); }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "补充登录路由", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("补充登录路由")
    });

    assert.equal(result.status, "ready");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /loginRoute/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner 兼容仅含文件路径的 read_file 简写动作", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-read-shorthand-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const actions: unknown[] = [
      { filePath: "src/router.ts", startLine: 1, endLine: 200 },
      {
        status: "ready",
        plan: {
          assumptions: [],
          tasks: [{ id: "T1", type: "implement", goal: "补充登录路由", dependencies: [], acceptanceCriteria: ["路由已定义"] }],
          completionCriteria: ["登录路由已定义"]
        }
      }
    ];
    const prompts: string[] = [];
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction(input: string) { prompts.push(input); return actions.shift(); }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "补充登录路由", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("补充登录路由")
    });

    assert.equal(result.status, "ready");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /loginRoute/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner Runtime 不暴露写入工具", async () => {
  const model: PlannerAgentDecisionModel = {
    async createPlan() { throw new Error("不应调用"); },
    async replan() { throw new Error("不应调用"); },
    async nextAction() { return { type: "tool", tool: "writeFile", args: { filePath: "src/router.ts" } }; }
  };
  const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
    goal: "补充登录路由",
    knownFacts: [],
    constraints: [],
    readScope: ["src/**"],
    writeScope: ["src/**"],
    state: createAgentState("补充登录路由")
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.blockers.join(" "), /无权调用工具|writeFile/);
});

test("Planner 对可读取上下文返回 missing_context 时会被要求继续调用只读工具", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-retry-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const actions: unknown[] = [
      { status: "missing_context", required: ["需要路由文件内容"] },
      { type: "tool", tool: "read_file", args: { filePath: "src/router.ts" } },
      {
        status: "ready",
        plan: {
          assumptions: [],
          tasks: [{ id: "T1", type: "implement", goal: "补充登录路由", dependencies: [], acceptanceCriteria: ["路由已定义"] }],
          completionCriteria: ["登录路由已定义"]
        }
      }
    ];
    const prompts: string[] = [];
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction(input: string) {
        prompts.push(input);
        return actions.shift();
      }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "补充登录路由",
      knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("补充登录路由")
    });

    assert.equal(result.status, "ready");
    assert.equal(prompts.length, 3);
    assert.match(prompts[1], /planner_policy/);
    assert.match(prompts[2], /loginRoute/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner 用尽 16 次只读调用后仍可在下一轮生成计划", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-budget-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const actions: unknown[] = Array.from({ length: 16 }, (_, index) => ({
      type: "tool",
      tool: "read_file",
      args: { filePath: "src/router.ts", startLine: index + 1 }
    }));
    actions.push({
      status: "ready",
      plan: {
        assumptions: ["未读取的页面细节由实现任务补充确认"],
        tasks: [{ id: "T1", type: "implement", goal: "补充登录路由", dependencies: [], acceptanceCriteria: ["路由已定义"] }],
        completionCriteria: ["登录路由已定义"]
      }
    });
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction() { return actions.shift(); }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "补充登录路由", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("补充登录路由")
    });

    assert.equal(result.status, "ready");
    assert.equal(actions.length, 0);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner 达到 30 次读取且模型仍探索时使用保守计划兜底", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-fallback-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    let toolCalls = 0;
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction() {
        toolCalls += 1;
        return { type: "tool", tool: "read_file", args: { filePath: "src/router.ts", startLine: toolCalls } };
      }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "完成登录模块迁移", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("完成登录模块迁移")
    });

    assert.equal(result.status, "ready");
    // 30 次是真正执行的只读调用，之后还会有 4 次收敛尝试再进入 Runtime 兜底。
    assert.equal(toolCalls, 34);
    if (result.status === "ready") assert.equal(result.plan.tasks.length, 4);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner 不会重复执行相同的只读请求", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-dedup-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "router.ts"), "export const loginRoute = '/login';\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const actions: unknown[] = [
      { type: "tool", tool: "read_file", args: { filePath: "src/router.ts" } },
      { type: "tool", tool: "read_file", args: { filePath: "src/router.ts" } },
      {
        status: "ready",
        plan: {
          assumptions: [],
          tasks: [{ id: "T1", type: "implement", goal: "补充登录路由", dependencies: [], acceptanceCriteria: ["路由已定义"] }],
          completionCriteria: ["登录路由已定义"]
        }
      }
    ];
    const prompts: string[] = [];
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction(input: string) { prompts.push(input); return actions.shift(); }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "补充登录路由", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("补充登录路由")
    });

    assert.equal(result.status, "ready");
    assert.match(prompts[2], /duplicate_tool_action/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Planner 将不存在的目标目录作为可创建前置条件而不是失败", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-planner-missing-directory-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "views"), { recursive: true });
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const actions: unknown[] = [
      { type: "tool", tool: "list_directory", args: { path: "src/views/login" } },
      {
        status: "ready",
        plan: {
          assumptions: ["src/views/login 需要在实现阶段创建"],
          tasks: [{ id: "T1", type: "implement", goal: "创建登录页面目录并新增组件", dependencies: [], acceptanceCriteria: ["目标目录和页面组件已创建"] }],
          completionCriteria: ["登录页面已创建"]
        }
      }
    ];
    const prompts: string[] = [];
    const model: PlannerAgentDecisionModel = {
      async createPlan() { throw new Error("不应调用"); },
      async replan() { throw new Error("不应调用"); },
      async nextAction(input: string) { prompts.push(input); return actions.shift(); }
    };
    const result = await new PlannerAgentRuntime(new PlannerAgent(model)).createPlan({
      goal: "创建登录页面", knownFacts: [], constraints: [], readScope: ["src/**"], writeScope: ["src/**"], state: createAgentState("创建登录页面")
    });

    assert.equal(result.status, "ready");
    assert.match(prompts[1], /missingDirectory/);
    assert.match(prompts[1], /先创建它/);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
