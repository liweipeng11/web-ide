import assert from "node:assert/strict";
import test from "node:test";
import type { AgentTaskPacket, RuntimeTool } from "./contracts.js";
import { isPathInScope, PermissionManager } from "./permissionManager.js";

const task: AgentTaskPacket = {
  taskId: "T1",
  goal: "探索 Runtime",
  context: null,
  constraints: [],
  acceptanceCriteria: ["输出事实"],
  readScope: ["src/**", "package.json"],
  writeScope: ["src/runtime/**"],
  allowedTools: ["read_file"]
};

const readTool: RuntimeTool = {
  name: "read_file",
  description: "读取文件",
  effect: "read",
  getTargetPaths: (args) => [String(args.filePath ?? "")],
  async execute() {
    return "content";
  }
};

const editTool: RuntimeTool = {
  name: "edit_file",
  description: "编辑文件",
  effect: "write",
  getTargetPaths: (args) => [String(args.filePath ?? "")],
  async execute() {
    return { changed: true };
  }
};

test("路径范围支持精确路径、通配符和 Windows 分隔符", () => {
  assert.equal(isPathInScope("package.json", ["package.json"]), true);
  assert.equal(isPathInScope("src/runtime/contracts.ts", ["src/**"]), true);
  assert.equal(isPathInScope("src\\runtime\\contracts.ts", ["src/runtime/*.ts"]), true);
  assert.equal(isPathInScope("tests/runtime.test.ts", ["src/**"]), false);
});

test("Explorer 可以调用任务允许的只读工具", () => {
  const manager = new PermissionManager([{ agentId: "explorer", allowedTools: ["read_file"] }]);
  assert.doesNotThrow(() => manager.checkTool("explorer", task, readTool, { filePath: "src/index.ts" }));
});

test("Explorer 不能调用写工具", () => {
  const manager = new PermissionManager([{ agentId: "explorer", allowedTools: ["read_file"] }]);
  assert.throws(
    () => manager.checkTool("explorer", { ...task, allowedTools: ["read_file", "edit_file"] }, editTool, { filePath: "src/runtime/contracts.ts" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PERMISSION_DENIED"
  );
});

test("Runtime 拒绝读写范围之外的路径和工作区逃逸路径", () => {
  const manager = new PermissionManager([{ agentId: "explorer", allowedTools: ["read_file"] }]);
  assert.throws(
    () => manager.checkTool("explorer", task, readTool, { filePath: "docs/secret.md" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SCOPE_VIOLATION"
  );
  assert.throws(
    () => manager.checkTool("explorer", task, readTool, { filePath: "../secret.md" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SCOPE_VIOLATION"
  );
});

test("AgentResult 不能声明 writeScope 之外的变更", () => {
  const manager = new PermissionManager([{ agentId: "developer", allowedTools: ["edit_file"] }]);
  assert.throws(
    () => manager.checkResult(task, {
      taskId: "T1",
      status: "success",
      summary: "完成",
      facts: [],
      changedFiles: ["src/payment/service.ts"],
      evidence: [],
      blockers: []
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "SCOPE_VIOLATION"
  );
});
