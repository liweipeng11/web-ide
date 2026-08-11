import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plan } from "../../runtime/contracts.js";
import { setWorkspaceRoot } from "../../workspaceStore.js";
import { ExplorerAgent } from "./explorerAgent.js";
import { ExplorerAgentRuntime } from "./explorerAgentRuntime.js";
import type { ExplorerAgentDecisionModel } from "./explorerAgentModel.js";

class SequenceModel implements ExplorerAgentDecisionModel {
  constructor(private readonly actions: unknown[]) {}
  async nextAction() {
    if (!this.actions.length) throw new Error("测试动作已耗尽");
    return this.actions.shift();
  }
}

function createPlan(readScope = ["src/**"]): Plan {
  return {
    version: 1,
    goal: "理解认证流程",
    assumptions: [],
    tasks: [{
      id: "T1",
      type: "explore",
      goal: "找到登录流程",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope,
      writeScope: [],
      acceptanceCriteria: ["给出认证入口证据"],
      status: "pending"
    }],
    completionCriteria: ["认证流程已确认"]
  };
}

test("Explorer Runtime 使用真实只读工具定位认证文件", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-explorer-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "routes"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "routes", "auth.ts"), "export function login() { return authenticate(); }\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const model = new SequenceModel([
      { type: "tool", tool: "grep", args: { pattern: "login", path: "src" } },
      { type: "tool", tool: "read_file", args: { filePath: "src/routes/auth.ts", startLine: 1 } },
      {
        type: "finish",
        result: {
          summary: "认证入口位于 auth 路由",
          relevantFiles: ["src/routes/auth.ts"],
          facts: [{ statement: "login 调用 authenticate", evidence: ["src/routes/auth.ts:1"] }],
          unknowns: []
        }
      }
    ]);
    const execution = await new ExplorerAgentRuntime(new ExplorerAgent(model)).executePlanTask(createPlan(), "T1");

    assert.equal(execution.result.status, "success");
    assert.deepEqual(execution.exploration?.relevantFiles, ["src/routes/auth.ts"]);
    assert.deepEqual(execution.state.completedTasks, ["T1"]);
    assert.deepEqual(execution.state.changedFiles, []);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Explorer Runtime 在工具执行前阻止 readScope 越权", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-explorer-scope-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "docs"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "docs", "secret.md"), "secret\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const model = new SequenceModel([
      { type: "tool", tool: "read_file", args: { filePath: "docs/secret.md" } }
    ]);
    const execution = await new ExplorerAgentRuntime(new ExplorerAgent(model)).executePlanTask(createPlan(), "T1");

    assert.equal(execution.result.status, "failed");
    assert.match(execution.result.blockers[0], /范围之外|scope/i);
    assert.equal(execution.exploration, undefined);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Explorer Runtime 执行后续探索任务时恢复已完成依赖", async () => {
  const plan = createPlan();
  plan.tasks[0].status = "completed";
  plan.tasks.push({
    ...plan.tasks[0],
    id: "T2",
    goal: "补充认证影响范围",
    dependencies: ["T1"],
    status: "pending"
  });
  const model = new SequenceModel([{
    type: "finish",
    result: {
      summary: "影响范围已确认",
      relevantFiles: ["src/routes/auth.ts"],
      facts: [{ statement: "认证入口受影响", evidence: ["src/routes/auth.ts:1"] }],
      unknowns: []
    }
  }]);
  const execution = await new ExplorerAgentRuntime(new ExplorerAgent(model)).executePlanTask(plan, "T2");

  assert.equal(execution.result.status, "success");
  assert.deepEqual(execution.state.completedTasks.sort(), ["T1", "T2"]);
});
