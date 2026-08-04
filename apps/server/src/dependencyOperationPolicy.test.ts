import assert from "node:assert/strict";
import test from "node:test";
import type { AgentContext } from "./agentToolTypes.js";
import type { AgentToolDefinition } from "./agentToolTypes.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { runAgentRuntime } from "./agentRuntime.js";
import {
  explicitlyAllowsManifestEditing,
  getDependencyOperationEditBlockReason,
  isDependencyManagedFile,
  isDependencyManagerCommand,
  isDependencyOperationRequest
} from "./dependencyOperationPolicy.js";

function context(userGoal: string, commandsRun: AgentContext["commandsRun"] = []): AgentContext {
  return { userGoal, filesRead: [], searchQueries: [], searchResultFiles: [], relevantFiles: [], commandsRun };
}

test("识别多生态依赖操作、清单文件和包管理器命令", () => {
  assert.equal(isDependencyOperationRequest("为前端添加 Element UI 组件库"), true);
  assert.equal(isDependencyOperationRequest("upgrade the pytest dependency"), true);
  assert.equal(isDependencyManagedFile("apps/web/package.json"), true);
  assert.equal(isDependencyManagedFile("backend/pyproject.toml"), true);
  assert.equal(isDependencyManagedFile("src/main.ts"), false);
  assert.equal(isDependencyManagerCommand("npm --prefix apps/web install element-ui@2.15.14"), true);
  assert.equal(isDependencyManagerCommand("uv add fastapi"), true);
  assert.equal(isDependencyManagerCommand("cargo add serde"), true);
  assert.equal(isDependencyManagerCommand("pnpm test"), false);
});

test("依赖任务在首次编辑清单前要求使用包管理器", () => {
  const reason = getDependencyOperationEditBlockReason({
    toolName: "replaceInFile",
    toolArguments: { filePath: "apps/web/package.json", search: "old", replace: "new" },
    agentContext: context("为 web 项目添加日期处理依赖"),
    runCommandAvailable: true
  });

  assert.match(reason || "", /runCommand first/i);
  assert.match(reason || "", /lockfiles atomically/i);
});

test("依赖任务不会阻止同一计划中的普通源码配置", () => {
  const reason = getDependencyOperationEditBlockReason({
    toolName: "proposePatch",
    toolArguments: { plannedChanges: [{ filePath: "apps/web/src/main.ts" }] },
    agentContext: context("添加 UI 组件库并在入口注册"),
    runCommandAvailable: true
  });

  assert.equal(reason, null);
});

test("包管理器成功后阻止模型再次手改生成的清单", () => {
  const reason = getDependencyOperationEditBlockReason({
    toolName: "proposePatch",
    toolArguments: { plannedChanges: [{ filePath: "package.json" }, { filePath: "src/main.ts" }] },
    agentContext: context("添加 UI 组件库", [{ command: "pnpm add element-plus", status: "success", exitCode: 0 }]),
    runCommandAvailable: true
  });

  assert.match(reason || "", /already managed/i);
  assert.match(reason || "", /do not patch package\.json/i);
});

test("包管理器失败后要求基于输出修正命令，而非绕过失败", () => {
  const reason = getDependencyOperationEditBlockReason({
    toolName: "writeFile",
    toolArguments: { filePath: "pyproject.toml", content: "" },
    agentContext: context("安装 Python 依赖", [{ command: "uv add missing-package", status: "failed", exitCode: 1 }]),
    runCommandAvailable: true
  });

  assert.match(reason || "", /Inspect its output/i);
  assert.match(reason || "", /corrected package-manager command/i);
});

test("用户明确要求手改或环境没有命令工具时保留受控退路", () => {
  assert.equal(explicitlyAllowsManifestEditing("不要执行命令，手动修改 package.json 依赖"), true);

  const manualReason = getDependencyOperationEditBlockReason({
    toolName: "replaceInFile",
    toolArguments: { filePath: "package.json" },
    agentContext: context("不要执行命令，手动修改 package.json 添加依赖"),
    runCommandAvailable: true
  });
  const unavailableReason = getDependencyOperationEditBlockReason({
    toolName: "replaceInFile",
    toolArguments: { filePath: "package.json" },
    agentContext: context("添加一个依赖包"),
    runCommandAvailable: false
  });

  assert.equal(manualReason, null);
  assert.equal(unavailableReason, null);
});

test("Runtime 会拦截依赖清单文本编辑并把模型引导到 runCommand", async () => {
  let editExecuted = false;
  const tool = (name: string, onExecute?: () => void): AgentToolDefinition => ({
    name,
    description: `Test tool ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async execute() {
      onExecute?.();
      return { changed: true };
    },
    summarize(value, cached) {
      return { value, cached };
    }
  });
  let modelCalls = 0;

  const result = await runAgentRuntime({
    userRequest: "为前端添加 Element UI 组件库",
    mode: "act",
    maxSteps: 2,
    contextBudgetEnabled: false,
    registry: createAgentToolRegistry([
      tool("replaceInFile", () => { editExecuted = true; }),
      tool("runCommand")
    ]),
    requestCompletion: async () => {
      modelCalls += 1;
      return modelCalls === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
            id: "manual-manifest-edit",
            type: "function" as const,
            function: {
              name: "replaceInFile",
              arguments: JSON.stringify({ filePath: "clr-vue-app/package.json", search: "old", replace: "new" })
            }
          }] } }] }
        : { choices: [{ message: { role: "assistant", content: "依赖安装尚未执行。" } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(editExecuted, false);
  assert.equal(result.messages.some((message) => message.role === "tool"
    && String(message.content).includes("must be performed with the project's detected package manager via runCommand first")), true);
});
