import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DeveloperAgent } from "../agents/developer/developerAgent.js";
import type { DeveloperAgentDecisionModel } from "../agents/developer/developerAgentModel.js";
import { DeveloperAgentRuntime } from "../agents/developer/developerAgentRuntime.js";
import { ExplorerAgent } from "../agents/explorer/explorerAgent.js";
import type { ExplorerAgentDecisionModel } from "../agents/explorer/explorerAgentModel.js";
import { ExplorerAgentRuntime } from "../agents/explorer/explorerAgentRuntime.js";
import { MainAgent } from "../agents/main/mainAgent.js";
import type { MainAgentDecisionModel } from "../agents/main/mainAgentModel.js";
import { MainAgentOrchestrator } from "../agents/main/mainAgentOrchestrator.js";
import { MainAgentRuntime } from "../agents/main/mainAgentRuntime.js";
import { PlannerAgent } from "../agents/planner/plannerAgent.js";
import type { PlannerAgentDecisionModel } from "../agents/planner/plannerAgentModel.js";
import { getWorkspaceRoot, setWorkspaceRoot } from "../workspaceStore.js";

class SequenceModel implements ExplorerAgentDecisionModel, DeveloperAgentDecisionModel {
  constructor(private readonly actions: unknown[]) {}

  async nextAction() {
    if (!this.actions.length) throw new Error("阶段 6 E2E 模型动作已耗尽。");
    return this.actions.shift();
  }
}

class ComplexMainModel implements MainAgentDecisionModel {
  async route() {
    return {
      intent: "code_change",
      complexity: "complex",
      route: "planned",
      requiredCapabilities: ["planning", "exploration", "editing", "testing"]
    };
  }

  async nextAction() {
    throw new Error("复杂任务不应进入 Main 的 direct/main_loop 工具循环。");
  }
}

class SimpleMainModel implements MainAgentDecisionModel {
  private readonly actions = [
    { type: "respond", content: "login 函数负责处理登录请求。" },
    { type: "finish" }
  ];

  async route() {
    return {
      intent: "question",
      complexity: "simple",
      route: "direct",
      requiredCapabilities: []
    };
  }

  async nextAction() {
    return this.actions.shift();
  }
}

class AuthPlannerModel implements PlannerAgentDecisionModel {
  async createPlan() {
    return {
      status: "ready",
      plan: {
        assumptions: [],
        tasks: [
          {
            id: "T1",
            type: "explore",
            goal: "定位登录实现和测试",
            dependencies: [],
            acceptanceCriteria: ["确认登录实现和相关测试"]
          },
          {
            id: "T2",
            type: "implement",
            goal: "为登录接口增加每分钟 5 次的限流",
            dependencies: ["T1"],
            acceptanceCriteria: ["同一用户第 6 次登录返回 429"]
          },
          {
            id: "T3",
            type: "test",
            goal: "运行认证限流测试",
            dependencies: ["T2"],
            acceptanceCriteria: ["同一用户第 6 次登录返回 429"]
          }
        ],
        completionCriteria: ["同一用户第 6 次登录返回 429"]
      }
    };
  }

  async replan() {
    throw new Error("阶段 6 不应自动重规划。");
  }
}

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/auth-project");

test("阶段 6 simple 问题绕过 Planner 并由 Main 直接完成", async () => {
  const runtime = new MainAgentRuntime({ agent: new MainAgent(new SimpleMainModel()) });
  const orchestration = await new MainAgentOrchestrator(runtime).run({
    goal: "解释 auth.ts 的 login 函数",
    knownFacts: ["文件 src/auth.ts：export function login() { return { status: 200 }; }"]
  });

  assert.equal(orchestration.status, "completed");
  assert.deepEqual(orchestration.trace.calledAgents, ["main"]);
  assert.equal(orchestration.trace.calledAgents.includes("planner"), false);
  assert.match(orchestration.summary, /login/);
});

test("阶段 6 真实 Runtime 将五个 Agent 串成完整编码流水线", async () => {
  const previousRoot = getWorkspaceRoot();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-phase6-auth-"));
  try {
    await fs.cp(fixtureRoot, workspaceRoot, { recursive: true });
    await setWorkspaceRoot(workspaceRoot, { persist: false });

    const explorer = new ExplorerAgentRuntime(new ExplorerAgent(new SequenceModel([
      { type: "tool", tool: "read_file", args: { filePath: "src/auth.js" } },
      { type: "tool", tool: "read_file", args: { filePath: "tests/auth.test.js" } },
      {
        type: "finish",
        result: {
          summary: "已定位登录实现和限流验收测试",
          relevantFiles: ["src/auth.js", "tests/auth.test.js"],
          facts: [{ statement: "登录当前始终返回 200", evidence: ["src/auth.js:2"] }],
          unknowns: []
        }
      }
    ])));
    const developer = new DeveloperAgentRuntime(new DeveloperAgent(new SequenceModel([
      { type: "tool", tool: "read_file", args: { filePath: "src/auth.js" } },
      {
        type: "tool",
        tool: "apply_patch",
        args: {
          operation: "replace",
          filePath: "src/auth.js",
          search: "export function login() {\n  return { status: 200 };\n}",
          replace: "const attempts = new Map();\n\nexport function login(userId) {\n  const nextAttempt = (attempts.get(userId) ?? 0) + 1;\n  attempts.set(userId, nextAttempt);\n  return { status: nextAttempt > 5 ? 429 : 200 };\n}"
        }
      },
      {
        type: "finish",
        result: {
          summary: "登录限流已实现",
          facts: ["同一用户前 5 次返回 200，第 6 次返回 429"],
          evidence: ["src/auth.js"]
        }
      }
    ])));
    const runtime = new MainAgentRuntime({
      agent: new MainAgent(new ComplexMainModel()),
      planner: new PlannerAgent(new AuthPlannerModel()),
      explorer,
      developer
    });
    const orchestration = await new MainAgentOrchestrator(runtime).run({
      goal: "给登录接口增加限流，每分钟 5 次，超过返回 429，并增加测试",
      readScope: ["src/**", "tests/**", "package.json"],
      writeScope: ["src/auth.js"],
      acceptanceCriteria: ["同一用户第 6 次登录返回 429"],
      testScope: ["tests/auth.test.js"],
      acceptanceEvidence: [{
        criterion: "同一用户第 6 次登录返回 429",
        testFiles: ["tests/auth.test.js"]
      }]
    });

    assert.equal(orchestration.status, "completed", orchestration.summary);
    assert.deepEqual(orchestration.trace.calledAgents, ["main", "planner", "explorer", "developer", "tester"]);
    assert.deepEqual(orchestration.plan?.tasks.map((task) => task.status), ["completed", "completed", "completed"]);
    assert.match(await fs.readFile(path.join(workspaceRoot, "src", "auth.js"), "utf8"), /nextAttempt > 5 \? 429 : 200/);
    const tester = orchestration.executions.find((execution) => execution.agent === "tester");
    assert.equal(tester?.execution.result.status, "success");
  } finally {
    if (previousRoot) await setWorkspaceRoot(previousRoot, { persist: false });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
