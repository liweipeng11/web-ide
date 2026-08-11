import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plan } from "../../runtime/contracts.js";
import { rollbackCheckpoint } from "../../checkpointStore.js";
import { setWorkspaceRoot } from "../../workspaceStore.js";
import { DeveloperAgent } from "./developerAgent.js";
import { DeveloperAgentRuntime } from "./developerAgentRuntime.js";
import type { DeveloperAgentDecisionModel } from "./developerAgentModel.js";

class SequenceModel implements DeveloperAgentDecisionModel {
  constructor(private readonly actions: unknown[]) {}
  async nextAction() {
    if (!this.actions.length) throw new Error("测试动作已耗尽");
    return this.actions.shift();
  }
}

function createPlan(): Plan {
  return {
    version: 1,
    goal: "修改认证超时",
    assumptions: [],
    tasks: [
      {
        id: "T1",
        type: "explore",
        goal: "定位认证配置",
        dependencies: [],
        requiredCapabilities: ["exploration"],
        readScope: ["src/auth/**"],
        writeScope: [],
        acceptanceCriteria: ["定位配置文件"],
        status: "completed"
      },
      {
        id: "T2",
        type: "implement",
        goal: "把认证超时改为 30 秒",
        dependencies: ["T1"],
        requiredCapabilities: ["editing"],
        readScope: ["src/auth/**"],
        writeScope: ["src/auth/**"],
        acceptanceCriteria: ["认证超时为 30 秒"],
        status: "pending"
      }
    ],
    completionCriteria: ["认证超时修改完成"]
  };
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-developer-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "auth"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "auth", "service.ts"), "export const timeout = 10;\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({
      private: true,
      scripts: { typecheck: "node -e \"process.exit(0)\"" }
    }), "utf8");
    await fs.mkdir(path.join(workspaceRoot, "src", "payment"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "payment", "service.ts"), "export const enabled = true;\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("Developer Runtime 在允许范围内应用补丁并记录 changedFiles", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const model = new SequenceModel([
      { type: "tool", tool: "read_file", args: { filePath: "src/auth/service.ts" } },
      {
        type: "tool",
        tool: "apply_patch",
        args: {
          operation: "replace",
          filePath: "src/auth/service.ts",
          search: "timeout = 10",
          replace: "timeout = 30"
        }
      },
      {
        type: "finish",
        result: {
          summary: "认证超时已修改",
          facts: ["timeout 为 30"],
          evidence: ["src/auth/service.ts:1"]
        }
      }
    ]);
    const execution = await new DeveloperAgentRuntime(new DeveloperAgent(model)).executePlanTask(createPlan(), "T2");

    assert.equal(execution.result.status, "success");
    assert.deepEqual(execution.result.changedFiles, ["src/auth/service.ts"]);
    assert.deepEqual(execution.state.completedTasks.sort(), ["T1", "T2"]);
    assert.deepEqual(execution.state.changedFiles, ["src/auth/service.ts"]);
    assert.match(await fs.readFile(path.join(workspaceRoot, "src", "auth", "service.ts"), "utf8"), /timeout = 30/);
    assert.equal(execution.checkpointIds.length, 1);
    await rollbackCheckpoint(execution.checkpointIds[0]);
    assert.match(await fs.readFile(path.join(workspaceRoot, "src", "auth", "service.ts"), "utf8"), /timeout = 10/);
  });
});

test("Developer Runtime 可以在授权范围创建新文件", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const plan = createPlan();
    plan.tasks[1].goal = "新增认证常量";
    const model = new SequenceModel([
      {
        type: "tool",
        tool: "apply_patch",
        args: {
          operation: "create",
          filePath: "src/auth/constants.ts",
          content: "export const timeout = 30;\n"
        }
      },
      {
        type: "finish",
        result: { summary: "认证常量已创建", facts: [], evidence: ["src/auth/constants.ts:1"] }
      }
    ]);
    const execution = await new DeveloperAgentRuntime(new DeveloperAgent(model)).executePlanTask(plan, "T2");

    assert.equal(execution.result.status, "success");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "auth", "constants.ts"), "utf8"), "export const timeout = 30;\n");
  });
});

test("Developer Runtime 通过真实命令内核运行白名单局部检查", async () => {
  await withWorkspace(async () => {
    const model = new SequenceModel([
      { type: "tool", tool: "read_file", args: { filePath: "src/auth/service.ts" } },
      {
        type: "tool",
        tool: "apply_patch",
        args: {
          operation: "replace",
          filePath: "src/auth/service.ts",
          search: "timeout = 10",
          replace: "timeout = 30"
        }
      },
      { type: "tool", tool: "run_local_check", args: { command: "pnpm typecheck" } },
      {
        type: "finish",
        result: { summary: "认证超时已修改并通过类型检查", facts: [], evidence: ["pnpm typecheck"] }
      }
    ]);

    const execution = await new DeveloperAgentRuntime(new DeveloperAgent(model)).executePlanTask(createPlan(), "T2");

    assert.equal(execution.result.status, "success");
    assert.deepEqual(execution.result.evidence, ["pnpm typecheck"]);
  });
});

test("Developer Runtime 在写入前阻止 writeScope 越权", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const model = new SequenceModel([
      { type: "tool", tool: "read_file", args: { filePath: "src/auth/service.ts" } },
      {
        type: "tool",
        tool: "apply_patch",
        args: {
          operation: "create",
          filePath: "src/payment/new-service.ts",
          content: "export const value = 1;\n"
        }
      }
    ]);
    const execution = await new DeveloperAgentRuntime(new DeveloperAgent(model)).executePlanTask(createPlan(), "T2");

    assert.equal(execution.result.status, "failed");
    assert.match(execution.result.blockers[0], /范围之外/);
    await assert.rejects(() => fs.stat(path.join(workspaceRoot, "src", "payment", "new-service.ts")));
  });
});

test("Developer Runtime 保留 blocked 范围申请且不写文件", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const model = new SequenceModel([{
      type: "request_scope_change",
      reason: "需要同步支付服务",
      requiredScope: ["src/payment/service.ts"]
    }]);
    const execution = await new DeveloperAgentRuntime(new DeveloperAgent(model)).executePlanTask(createPlan(), "T2");

    assert.equal(execution.result.status, "blocked");
    assert.deepEqual(execution.result.scopeChangeRequest?.requiredScope, ["src/payment/service.ts"]);
    assert.equal(execution.state.status, "waiting_user");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "payment", "service.ts"), "utf8"), "export const enabled = true;\n");
  });
});

test("Developer Runtime 拒绝非实现任务和依赖未完成的任务", async () => {
  const runtime = new DeveloperAgentRuntime(new DeveloperAgent(new SequenceModel([])));
  await assert.rejects(
    () => runtime.executePlanTask(createPlan(), "T1"),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "INVALID_CONTRACT")
  );

  const plan = createPlan();
  plan.tasks[0].status = "pending";
  await assert.rejects(
    () => runtime.executePlanTask(plan, "T2"),
    (error: unknown) => Boolean(error && typeof error === "object" && (error as { code?: string }).code === "TASK_DEPENDENCY_NOT_SATISFIED")
  );
});
