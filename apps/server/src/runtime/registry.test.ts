import assert from "node:assert/strict";
import test from "node:test";
import type { Agent, RuntimeTool } from "./contracts.js";
import { AgentRegistry } from "./agentRegistry.js";
import { ToolRegistry } from "./toolRegistry.js";

const agent: Agent = {
  id: "explorer",
  capabilities: ["read"],
  async run(task) {
    return { taskId: task.taskId, status: "success", summary: "完成", facts: [], changedFiles: [], evidence: [], blockers: [] };
  }
};

const tool: RuntimeTool = {
  name: "read_file",
  description: "读取文件",
  effect: "read",
  getTargetPaths: () => ["src/index.ts"],
  async execute() {
    return "content";
  }
};

test("AgentRegistry 校验能力并拒绝重复身份", () => {
  const registry = new AgentRegistry([agent]);
  assert.equal(registry.requireCapabilities("explorer", ["read"]).id, "explorer");
  assert.throws(
    () => registry.requireCapabilities("explorer", ["edit"]),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "CAPABILITY_MISMATCH"
  );
  assert.throws(
    () => registry.register(agent),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DUPLICATE_AGENT"
  );
});

test("ToolRegistry 拒绝未知工具和重复工具", () => {
  const registry = new ToolRegistry([tool]);
  assert.equal(registry.get("read_file").effect, "read");
  assert.throws(
    () => registry.get("edit_file"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "UNKNOWN_TOOL"
  );
  assert.throws(
    () => registry.register(tool),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "DUPLICATE_TOOL"
  );
});
