import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { EXPLORER_TOOL_NAMES, explorerRuntimeTools } from "../agents/explorer/explorerTools.js";
import { runReadOnlyAgent, type ReadOnlyAgentModel } from "../langchain/agents/readOnlyAgent.js";
import { createReadOnlyToolRegistry } from "../langchain/agents/readOnlyToolRegistry.js";
import { baselineScenarios } from "../langgraph/testing/baselineScenarios.js";
import { readReadOnlyRuntimeRollout } from "../langgraph/rollout/featureFlags.js";
import { executeReadOnlyRuntimeRollout } from "../langgraph/rollout/runtimeSelector.js";
import type { AgentTaskPacket } from "../runtime/contracts.js";
import { PermissionManager } from "../runtime/permissionManager.js";
import { ToolRegistry } from "../runtime/toolRegistry.js";
import { getWorkspaceRoot, setWorkspaceRoot } from "../workspaceStore.js";

class ScriptedModel implements ReadOnlyAgentModel {
  private cursor = 0;
  readonly visibleTools: string[][] = [];

  constructor(private readonly responses: AIMessage[]) {}

  async invoke(_messages: readonly BaseMessage[], options: { tools: readonly DynamicStructuredTool[]; signal?: AbortSignal }) {
    this.visibleTools.push(options.tools.map((tool) => tool.name));
    const response = this.responses[this.cursor++];
    if (!response) throw new Error("Stage 2 模型脚本耗尽");
    return response;
  }
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return new AIMessage({ content: "", tool_calls: [{ id, name, args, type: "tool_call" }] });
}

async function fileSnapshot(workspaceRoot: string) {
  const files = ["src/auth.ts", "src/unchanged.ts"];
  return Object.fromEntries(await Promise.all(files.map(async (filePath) => [
    filePath,
    await fs.readFile(path.join(workspaceRoot, filePath), "utf8")
  ])));
}

test("阶段 2 只读 Agent 安全验收", async () => {
  const previousWorkspace = getWorkspaceRoot();
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-langgraph-stage2-"));
  try {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src/auth.ts"), "export function authenticate() { return true; }\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src/unchanged.ts"), "export const unchanged = true;\n", "utf8");
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const before = await fileSnapshot(workspaceRoot);

    const runtimeTools = new ToolRegistry(explorerRuntimeTools);
    const permissions = new PermissionManager([{ agentId: "langchain-read-only", allowedTools: [...EXPLORER_TOOL_NAMES] }]);
    const task: AgentTaskPacket = {
      taskId: "STAGE2-READ",
      goal: "定位认证入口",
      context: null,
      constraints: ["只读"],
      acceptanceCriteria: ["返回认证入口位置"],
      readScope: ["src/**"],
      writeScope: [],
      allowedTools: [...EXPLORER_TOOL_NAMES]
    };
    let permissionViolationCount = 0;
    const registry = createReadOnlyToolRegistry(
      runtimeTools.describeAvailable([...EXPLORER_TOOL_NAMES]),
      async (toolName, args) => {
        const tool = runtimeTools.get(toolName);
        try {
          permissions.checkTool("langchain-read-only", task, tool, args);
        } catch (error) {
          permissionViolationCount += 1;
          throw error;
        }
        return tool.execute(args, { agentId: "langchain-read-only", task });
      }
    );

    const question = await runReadOnlyAgent({
      goal: "这个项目是否包含认证入口？",
      model: new ScriptedModel([new AIMessage("包含认证入口。")]),
      registry
    });
    const analysisModel = new ScriptedModel([
      call("grep-auth", "grep", { pattern: "authenticate", path: "src" }),
      call("read-auth", "read_file", { filePath: "src/auth.ts" }),
      new AIMessage("认证入口位于 src/auth.ts。")
    ]);
    const analysis = await runReadOnlyAgent({ goal: "定位认证入口", model: analysisModel, registry });

    const readOnlyLegacy = baselineScenarios.filter((scenario) => ["question", "read_analysis"].includes(scenario.kind));
    const legacyPassRate = readOnlyLegacy.filter((scenario) => scenario.expectedOutcome === "completed").length / readOnlyLegacy.length;
    const nextResults = [question, analysis];
    const nextPassRate = nextResults.filter((result) => result.state.status === "completed").length / nextResults.length;

    assert.equal(nextPassRate >= legacyPassRate, true);
    assert.equal(permissionViolationCount, 0);
    assert.deepEqual(await fileSnapshot(workspaceRoot), before);
    assert.equal(analysis.state.readFileCount, 1);
    assert.equal(analysisModel.visibleTools.flat().some((name) => ["writeFile", "applyPatch", "runCommand"].includes(name)), false);

    const forged = await runReadOnlyAgent({
      goal: "尝试越权写入",
      model: new ScriptedModel([
        call("forged-write", "writeFile", { filePath: "src/auth.ts", content: "changed" }),
        new AIMessage("写入被拒绝。")
      ]),
      registry
    });
    assert.equal(forged.state.status, "completed");
    assert.deepEqual(await fileSnapshot(workspaceRoot), before);

    let nextCalls = 0;
    assert.deepEqual(readReadOnlyRuntimeRollout({}), { mode: "off" });
    const offResult = await executeReadOnlyRuntimeRollout({
      mode: "off",
      legacy: async () => "legacy",
      next: async () => { nextCalls += 1; return "next"; }
    });
    assert.equal(offResult, "legacy");
    assert.equal(nextCalls, 0);
  } finally {
    if (previousWorkspace) await setWorkspaceRoot(previousWorkspace, { persist: false });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
