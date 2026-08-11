import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DeveloperAgent } from "./agents/developer/developerAgent.js";
import type { DeveloperAgentDecisionModel } from "./agents/developer/developerAgentModel.js";
import { DeveloperAgentRuntime } from "./agents/developer/developerAgentRuntime.js";
import { MainAgentRuntime } from "./agents/main/mainAgentRuntime.js";
import type { Plan } from "./runtime/contracts.js";
import {
  approveTaskSessionPlan,
  createTaskSession,
  getTaskSession,
  setTaskSessionRuntimePlanning
} from "./taskSessionStore.js";
import { executeApprovedDeveloperTask } from "./developerExecutionService.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

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
    tasks: [{
      id: "T1",
      type: "implement",
      goal: "把认证超时改为 30 秒",
      dependencies: [],
      requiredCapabilities: ["editing"],
      readScope: ["src/auth/**"],
      writeScope: ["src/auth/**"],
      acceptanceCriteria: ["认证超时为 30 秒"],
      status: "pending"
    }],
    completionCriteria: ["认证超时修改完成"]
  };
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-developer-service-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src", "auth"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "auth", "service.ts"), "export const timeout = 10;\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("已批准计划通过生产服务执行 Developer 并持久化 checkpoint 与摘要", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const created = await createTaskSession("修改认证超时", { agentMode: "act" });
    await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: createPlan() });
    const approved = await approveTaskSessionPlan(created.id);
    assert.ok(approved);

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
    const runtime = new MainAgentRuntime({
      developer: new DeveloperAgentRuntime(new DeveloperAgent(model))
    });
    const result = await executeApprovedDeveloperTask(approved, { runtime });

    assert.equal(result.outcome, "executed");
    if (result.outcome !== "executed") return;
    assert.equal(result.execution.result.status, "success");
    assert.equal(result.execution.checkpointIds.length, 1);
    assert.match(await fs.readFile(path.join(workspaceRoot, "src", "auth", "service.ts"), "utf8"), /timeout = 30/);

    const persisted = await getTaskSession(created.id);
    assert.equal(persisted.runtimePlan?.tasks[0].status, "completed");
    assert.deepEqual(persisted.filesChanged, ["src/auth/service.ts"]);
    assert.deepEqual(persisted.checkpointIds, result.execution.checkpointIds);
    assert.equal(persisted.developerArtifacts?.at(-1)?.summary, "认证超时已修改");
  });
});

test("生产服务不会执行未批准计划", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const created = await createTaskSession("修改认证超时", { agentMode: "act" });
    const planned = await setTaskSessionRuntimePlanning(created.id, { status: "ready", plan: createPlan() });
    assert.ok(planned);
    let calls = 0;
    const result = await executeApprovedDeveloperTask(planned, {
      runtime: {
        async executeDeveloperTask() {
          calls += 1;
          throw new Error("未批准计划不应执行");
        },
        resolveDeveloperScopeChange() {
          throw new Error("未批准计划不应处理范围申请");
        }
      }
    });

    assert.equal(result.outcome, "not_applicable");
    assert.equal(calls, 0);
    assert.match(await fs.readFile(path.join(workspaceRoot, "src", "auth", "service.ts"), "utf8"), /timeout = 10/);
  });
});
