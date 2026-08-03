import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentBudgetPolicy } from "./agentBudgetPolicy.js";
import { resumeAgentRuntimeAfterApproval, runAgentRuntime } from "./agentRuntime.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { AI_AGENT_ACT_SYSTEM_PROMPT } from "./prompts.js";
import type { AgentCompletionResponse, AgentToolDefinition, AgentToolRuntime } from "./agentToolTypes.js";
import type { AgentStep } from "./types.js";
import { createTaskWorkflow } from "./taskWorkflow/index.js";
import type { RunMetrics } from "./observability/index.js";
import { resolveAgentNoProgressPolicy, resolveAgentRepeatToolCallThresholds } from "./config.js";
import { completionAgentToolDefinitions } from "./agentCompletionTools.js";

function createRuntimeTestTool(name: string, result: unknown, onExecute?: (runtime: AgentToolRuntime) => void): AgentToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true
    },
    async execute(_args, runtime) {
      onExecute?.(runtime);
      return result;
    },
    summarize(value, cached) {
      return { cached, value };
    }
  };
}

function createModelToolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) }
  };
}

test("启用显式完成协议后，自然停止不能直接 completed", async () => {
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "分析当前实现",
    mode: "plan",
    maxSteps: 2,
    contextBudgetEnabled: false,
    explicitCompletionRollout: { mode: "all" },
    registry: createAgentToolRegistry(completionAgentToolDefinitions),
    requestCompletion: async () => {
      completionCount += 1;
      return { choices: [{ message: { role: "assistant", content: "分析已经完成。" } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "incomplete");
  assert.equal(completionCount, 2);
  assert.match(result.statusReason ?? "", /没有调用 completeTask/);
  assert.equal(result.messages.some((message) => message.role === "user" && String(message.content).includes("completeTask")), true);
});

test("completeTask 与编辑工具混用时整轮拒绝且不执行编辑", async () => {
  let editExecutionCount = 0;
  let completionCount = 0;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("replaceInFile", { changed: true, filePath: "src/a.ts" }, () => { editExecutionCount += 1; }),
    ...completionAgentToolDefinitions
  ]);
  const result = await runAgentRuntime({
    userRequest: "分析并在需要时修改 src/a.ts",
    mode: "plan",
    maxSteps: 3,
    contextBudgetEnabled: false,
    registry,
    requestCompletion: async () => {
      completionCount += 1;
      return completionCount === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [
            createModelToolCall("edit-mixed", "replaceInFile", { filePath: "src/a.ts", search: "a", replace: "b" }),
            createModelToolCall("complete-mixed", "completeTask", { summary: "已完成", verified: true })
          ] } }] }
        : { choices: [{ message: { role: "assistant", content: null, tool_calls: [
            createModelToolCall("complete-only", "completeTask", { summary: "分析已完成", verified: true })
          ] } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
  assert.equal(editExecutionCount, 0);
  assert.equal(completionCount, 2);
  assert.equal(result.messages.some((message) => message.role === "tool" && String(message.content).includes("must be the only tool call")), true);
});

test("completeTask 参数不完整时返回工具错误并允许下一轮修正", async () => {
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "分析错误边界",
    mode: "plan",
    maxSteps: 3,
    contextBudgetEnabled: false,
    registry: createAgentToolRegistry(completionAgentToolDefinitions),
    requestCompletion: async () => {
      completionCount += 1;
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        completionCount === 1
          ? createModelToolCall("invalid-complete", "completeTask", { summary: "分析完成" })
          : createModelToolCall("valid-complete", "completeTask", { summary: "分析完成", verified: true })
      ] } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
  assert.equal(completionCount, 2);
  assert.equal(result.messages.some((message) => message.role === "tool" && String(message.content).includes("verified is required")), true);
});

test("completeTask 证据不足时继续运行，真实编辑后才能完成", async () => {
  let completionCount = 0;
  const steps: AgentStep[] = [];
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("replaceInFile", { changed: true, filePath: "src/a.ts" }),
    ...completionAgentToolDefinitions
  ]);
  const result = await runAgentRuntime({
    userRequest: "修改 src/a.ts",
    mode: "act",
    maxSteps: 4,
    contextBudgetEnabled: false,
    registry,
    onAgentStep: (step) => steps.push(step),
    requestCompletion: async () => {
      completionCount += 1;
      if (completionCount === 1) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
          createModelToolCall("premature-complete", "completeTask", { summary: "修改完成", verified: true })
        ] } }] };
      }
      if (completionCount === 2) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
          createModelToolCall("apply-edit", "replaceInFile", { filePath: "src/a.ts", search: "a", replace: "b" })
        ] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        createModelToolCall("verified-complete", "completeTask", { summary: "修改完成", verified: true, validationSummary: "已检查工具结果" })
      ] } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
  assert.equal(completionCount, 3);
  assert.equal(result.messages.some((message) => message.role === "tool" && String(message.content).includes("completeTask was rejected")), true);
  assert.equal(result.completionEvidence?.changedFileCount, 1);
  assert.equal(steps.filter((step) => step.type === "message" && step.content === "修改完成").length, 1);
});

test("相同完成证据第三次拒绝后终止循环，修改 summary 不能绕过", async () => {
  let providerCallCount = 0;
  let capturedMetrics: RunMetrics | undefined;
  const result = await runAgentRuntime({
    userRequest: "修改 src/a.ts",
    mode: "act",
    maxSteps: 8,
    contextBudgetEnabled: false,
    registry: createAgentToolRegistry([
      createRuntimeTestTool("writeFile", { success: true }),
      ...completionAgentToolDefinitions
    ]),
    requestCompletion: async () => {
      providerCallCount += 1;
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        createModelToolCall(`same-evidence-${providerCallCount}`, "completeTask", {
          summary: `第 ${providerCallCount} 版完成说明`,
          verified: true
        })
      ] } }] };
    },
    metricsRecorder: async (metrics) => { capturedMetrics = metrics; }
  });

  assert.equal(providerCallCount, 3);
  assert.equal(result.status, "incomplete");
  assert.match(result.statusReason ?? "", /完成证据没有变化/);
  assert.equal(result.messages.filter((message) => message.role === "tool").length, 3);
  assert.equal(result.messages.some((message) => message.role === "tool" && String(message.content).includes("禁止再次直接调用 completeTask")), true);
  assert.equal(capturedMetrics?.completionRequestCount, 3);
  assert.equal(capturedMetrics?.completionRejectedCount, 3);
  assert.equal(capturedMetrics?.sameEvidenceRejectionCount, 2);
  assert.equal(capturedMetrics?.completionLoopStoppedCount, 1);
});

test("编辑任务必须在最后变更后获得成功验证才能 completeTask", async () => {
  let completionCount = 0;
  let validationAttempt = 0;
  let capturedMetrics: RunMetrics | undefined;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("replaceInFile", { changed: true, filePath: "src/a.ts" }),
    // 注册 runCommand 表示环境具备验证能力；recordValidation 模拟审批后返回的命令结果。
    createRuntimeTestTool("runCommand", {}),
    createRuntimeTestTool("recordValidation", {}, (runtime) => {
      validationAttempt += 1;
      runtime.agentContext.commandsRun = [
        ...(runtime.agentContext.commandsRun ?? []),
        {
          command: "pnpm test",
          status: validationAttempt === 1 ? "failed" : "success",
          exitCode: validationAttempt === 1 ? 1 : 0,
          validation: true,
          finishedAt: Date.now() + validationAttempt
        }
      ];
    }),
    ...completionAgentToolDefinitions
  ]);

  const result = await runAgentRuntime({
    userRequest: "修改 src/a.ts 并运行测试",
    mode: "act",
    maxSteps: 8,
    contextBudgetEnabled: false,
    registry,
    requestCompletion: async () => {
      completionCount += 1;
      if (completionCount === 1) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
          createModelToolCall("edit-before-validation", "replaceInFile", { filePath: "src/a.ts" })
        ] } }] };
      }
      if (completionCount === 2 || completionCount === 4) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
          createModelToolCall(`validation-${completionCount}`, "recordValidation", { command: "pnpm test", attempt: completionCount })
        ] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        createModelToolCall(`complete-${completionCount}`, "completeTask", { summary: "修改和验证完成", verified: true, validationSummary: "pnpm test 通过" })
      ] } }] };
    },
    metricsRecorder: async (metrics) => { capturedMetrics = metrics; }
  });

  assert.equal(result.status, "completed");
  assert.equal(completionCount, 5);
  assert.equal(result.completionEvidence?.validationStatus, "passed");
  assert.equal(result.completionEvidence?.lastValidationAt !== undefined, true);
  assert.equal(result.messages.some((message) => message.role === "tool" && String(message.content).includes("验证命令执行失败")), true);
  assert.equal(capturedMetrics?.result.validationStatus, "passed");
  assert.equal(capturedMetrics?.result.validationCommandCount, 2);
});

test("verified:false 不会结束 Runtime，并按证据返回 incomplete", async () => {
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "分析验证状态",
    mode: "plan",
    maxSteps: 3,
    contextBudgetEnabled: false,
    registry: createAgentToolRegistry(completionAgentToolDefinitions),
    requestCompletion: async () => {
      completionCount += 1;
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [
        completionCount === 1
          ? createModelToolCall("unverified-complete", "completeTask", { summary: "分析完成但尚未验证", verified: false })
          : createModelToolCall("verified-complete", "completeTask", { summary: "分析和验证均已完成", verified: true })
      ] } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
  assert.equal(completionCount, 2);
  assert.equal(result.messages.some((message) => message.role === "tool"
    && String(message.content).includes('"completionStatus":"incomplete"')), true);
});

test("编辑任务零交付物会恢复一次并返回 incomplete", async () => {
  const steps: AgentStep[] = [];
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "新增用户服务",
    mode: "act",
    contextBudgetEnabled: false,
    registry: createAgentToolRegistry([createRuntimeTestTool("writeFile", { success: true })]),
    requestCompletion: async () => {
      completionCount += 1;
      return { choices: [{ message: { role: "assistant", content: "仅提供示例，没有修改文件。" } }] };
    },
    onAgentStep: (step) => steps.push(step),
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.completionEvidence?.generatedPatchCount, 0);
  assert.equal(result.completionEvidence?.changedFileCount, 0);
  assert.equal(result.requestedStatus, "completed");
  assert.match(result.statusReason || "", /没有生成补丁/);
  assert.equal(completionCount, 2);
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "completion_recovery"), true);
});

test("编辑任务直接写入后返回 completed", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("replaceInFile", { changed: true })]);
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "新增 src/userService.ts",
    mode: "act",
    contextBudgetEnabled: false,
    registry,
    requestCompletion: async () => {
      completionCount += 1;
      return completionCount === 1
        ? {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "replace-user-service",
                  type: "function",
                  function: { name: "replaceInFile", arguments: JSON.stringify({ filePath: "src/userService.ts", search: "old", replace: "new" }) }
                }]
              }
            }]
          }
        : { choices: [{ message: { role: "assistant", content: "文件已写入。" } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
});

test("自定义修复工具的明确 applied 结果可作为完成证据", async () => {
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("repairCode", { applied: true, filePath: "src/userService.ts" })
  ]);
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "修复 src/userService.ts",
    mode: "act",
    contextBudgetEnabled: false,
    registry,
    requestCompletion: async () => {
      completionCount += 1;
      return completionCount === 1
        ? {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "repair-user-service",
                  type: "function",
                  function: { name: "repairCode", arguments: "{}" }
                }]
              }
            }]
          }
        : { choices: [{ message: { role: "assistant", content: "修复已完成。" } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
});

test("编辑工具明确未产生变化时不得作为完成证据", async () => {
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("replaceInFile", { filePath: "src/userService.ts", changed: false })
  ]);
  let completionCount = 0;
  const result = await runAgentRuntime({
    userRequest: "修改 src/userService.ts",
    mode: "act",
    maxSteps: 2,
    contextBudgetEnabled: false,
    registry,
    requestCompletion: async () => {
      completionCount += 1;
      return completionCount === 1
        ? {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "replace-no-change",
                  type: "function",
                  function: { name: "replaceInFile", arguments: JSON.stringify({ filePath: "src/userService.ts", search: "old", replace: "old" }) }
                }]
              }
            }]
          }
        : { choices: [{ message: { role: "assistant", content: "修改已完成。" } }] };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.generatedPatchIds, []);
});

test("必须由用户选择的编辑任务返回 blocked", async () => {
  const result = await runAgentRuntime({
    userRequest: "新增数据库接入",
    mode: "act",
    contextBudgetEnabled: false,
    registry: createAgentToolRegistry([createRuntimeTestTool("writeFile", { success: true })]),
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "需要您选择 MySQL 或 PostgreSQL 后才能继续。" } }]
    }),
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "blocked");
});

test("agent runtime keeps calling model after tool results", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("readFile", { filePath: "src/a.ts", content: "hello" })]);
  const requests: Record<string, unknown>[] = [];
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-1",
                type: "function",
                function: { name: "readFile", arguments: JSON.stringify({ filePath: "src/a.ts" }) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "File read, ready to continue."
          }
        }
      ]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Analyze file",
    projectMemoryPrompt: "PROJECT_MEMORY_SENTINEL",
    registry,
    runId: "test-runtime-loop",
    requestCompletion: async (body) => {
      requests.push(body);
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.content, "File read, ready to continue.");
  assert.equal(requests.length, 2);
  assert.equal(result.messages.at(-2)?.role, "tool");
  const firstMessages = requests[0]?.messages as Array<{ role: string; content: string }>;
  assert.match(firstMessages[0]?.content || "", /PROJECT_MEMORY_SENTINEL/);
});

test("agent runtime injects confirmed negative evidence into subsequent model requests", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchFilesByName", {
    matches: [], query: "router", searchedPath: "src", exhaustive: true, cached: false, conclusion: "target_absent"
  }, (runtime) => {
    runtime.agentContext.negativeEvidence = [{
      kind: "path_absent", query: "router", scope: "src", sourceTool: "searchFilesByName", exhaustive: true, createdAt: 1
    }];
  })]);
  const requests: Record<string, unknown>[] = [];
  let completionCount = 0;

  await runAgentRuntime({
    userRequest: "配置路由",
    registry,
    contextBudgetEnabled: false,
    requestCompletion: async (body) => {
      requests.push(body);
      completionCount += 1;
      return completionCount === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "negative-search", type: "function", function: { name: "searchFilesByName", arguments: JSON.stringify({ query: "router", path: "src" }) } }] } }] }
        : { choices: [{ message: { role: "assistant", content: "将创建路由配置。" } }] };
    }
  });

  const secondMessages = requests[1].messages as Array<{ role: string; content?: string }>;
  const evidencePrompt = secondMessages.find((message) => message.role === "user" && message.content?.includes("负面证据"));
  assert.match(evidencePrompt?.content || "", /已完整检查 src，未发现路径或文件“router”/);
  assert.match(evidencePrompt?.content || "", /不要重复搜索相同范围/);
});

test("feature 任务将完整路径未命中提升为创建意图并阻止同职责重复搜索", async () => {
  let fileSearchExecutions = 0;
  let codeSearchExecutions = 0;
  let patchExecutions = 0;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("searchFilesByName", {
      matches: [], query: "router", searchedPath: "src", exhaustive: true, cached: false, conclusion: "target_absent"
    }, (runtime) => {
      fileSearchExecutions += 1;
      runtime.agentContext.negativeEvidence = [{
        kind: "path_absent",
        query: "router",
        scope: "src",
        sourceTool: "searchFilesByName",
        exhaustive: true,
        createdAt: 1
      }];
    }),
    createRuntimeTestTool("searchCode", [], () => { codeSearchExecutions += 1; }),
    createRuntimeTestTool("proposePatch", { patchId: "patch-router" }, () => { patchExecutions += 1; })
  ]);
  const requests: Record<string, unknown>[] = [];
  let completionCount = 0;
  const steps: AgentStep[] = [];

  const result = await runAgentRuntime({
    userRequest: "新增 Vue 路由配置",
    mode: "act",
    contextBudgetEnabled: false,
    registry,
    onAgentStep: (step) => steps.push(step),
    requestCompletion: async (body) => {
      requests.push(body);
      completionCount += 1;
      if (completionCount === 1) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: "find-router",
          type: "function",
          function: { name: "searchFilesByName", arguments: JSON.stringify({ query: "router", path: "src" }) }
        }] } }] };
      }
      if (completionCount === 2) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: "repeat-router-responsibility",
          type: "function",
          function: { name: "searchCode", arguments: JSON.stringify({ query: "VueRouter", path: "src" }) }
        }] } }] };
      }
      if (completionCount === 3) {
        return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
          id: "create-router-patch",
          type: "function",
          function: { name: "proposePatch", arguments: JSON.stringify({ files: ["src/router/index.js", "src/main.js"] }) }
        }] } }] };
      }
      return { choices: [{ message: { role: "assistant", content: "路由补丁已生成。" } }] };
    }
  });

  const secondMessages = requests[1].messages as Array<{ content?: string }>;
  assert.equal(fileSearchExecutions, 1);
  assert.equal(codeSearchExecutions, 0);
  assert.equal(patchExecutions, 1);
  assert.equal(result.agentContext.createIntents?.[0]?.target, "router");
  assert.equal(secondMessages.some((message) => message.content?.includes("已确认需要创建")), true);
  assert.match(result.messages.find((message) => message.role === "tool" && message.toolCallId === "repeat-router-responsibility")?.content || "", /create_intent_search_blocked/);
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "create_intent"), true);
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "create_intent_search_blocked"), true);
});

test("只读任务不会把完整未命中提升为创建意图", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchFilesByName", {
    matches: [], query: "router", searchedPath: "src", exhaustive: true, cached: false, conclusion: "target_absent"
  }, (runtime) => {
    runtime.agentContext.negativeEvidence = [{
      kind: "path_absent",
      query: "router",
      scope: "src",
      sourceTool: "searchFilesByName",
      exhaustive: true,
      createdAt: 1
    }];
  })]);
  let completionCount = 0;

  const result = await runAgentRuntime({
    userRequest: "只分析当前路由结构",
    mode: "plan",
    contextBudgetEnabled: false,
    registry,
    requestCompletion: async () => {
      completionCount += 1;
      return completionCount === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{
            id: "readonly-router",
            type: "function",
            function: { name: "searchFilesByName", arguments: JSON.stringify({ query: "router", path: "src" }) }
          }] } }] }
        : { choices: [{ message: { role: "assistant", content: "未发现独立路由文件。" } }] };
    }
  });

  assert.equal(result.agentContext.createIntents?.length ?? 0, 0);
});

test("context budget v2 compresses the model view while preserving the full runtime history", async () => {
  const registry = createAgentToolRegistry([]);
  const messages = [
    { id: "system-budget", role: "system" as const, content: "Keep safety rules." },
    { id: "old-user", role: "user" as const, content: "old request ".repeat(500) },
    { id: "old-assistant", role: "assistant" as const, content: "old result ".repeat(500) },
    { id: "current-user", role: "user" as const, content: "Current goal" }
  ];
  let sentMessageCount = 0;

  const result = await runAgentRuntime({
    userRequest: "Current goal",
    messages,
    agentContext: { userGoal: "Current goal", filesRead: [], searchQueries: [], searchResultFiles: [], relevantFiles: [], patternSearchPerformed: false, patternCandidateFiles: [], existenceCheckPerformed: false, unresolvedExistenceChecks: [], commandsRun: [], externalSources: [] },
    registry,
    contextBudgetEnabled: true,
    contextWindowTokens: 1_200,
    maxOutputTokens: 200,
    contextSafetyMarginTokens: 100,
    completeModel: async (request) => {
      sentMessageCount = request.messages.length;
      return { message: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 } };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
  assert.ok(sentMessageCount < messages.length);
  assert.equal(result.contextBudgetSnapshot?.automaticCompression, true);
  assert.ok(result.contextSummary?.coveredMessageIds.includes("old-user"));
  assert.equal(result.messages.some((message) => message.id === "old-user"), true);
});

test("context budget feature flag override can return to the legacy message path", async () => {
  const registry = createAgentToolRegistry([]);
  const messages = [
    { role: "system" as const, content: "rules" },
    { role: "user" as const, content: "legacy history ".repeat(300) },
    { role: "user" as const, content: "current" }
  ];
  let sentMessageCount = 0;
  let sentSystemPrompt = "";

  const result = await runAgentRuntime({
    userRequest: "current",
    messages,
    registry,
    contextBudgetEnabled: false,
    completeModel: async (request) => {
      sentMessageCount = request.messages.length;
      sentSystemPrompt = request.systemPrompt || "";
      return { message: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 } };
    },
    metricsRecorder: async () => undefined
  });

  assert.equal(sentMessageCount, messages.length - 1);
  assert.equal(sentSystemPrompt, "rules");
  assert.equal(result.contextBudgetSnapshot, undefined);
});

test("agent runtime returns patch ids generated by tools", async () => {
  const registry = createAgentToolRegistry([
    {
      name: "proposePatch",
      description: "Generate a pending patch",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: true
      },
      async execute(_args, runtime) {
        runtime.generatedPatchIds?.push("patch-runtime-1");
        return { patchId: "patch-runtime-1" };
      },
      summarize(value, cached) {
        return { cached, value };
      }
    }
  ]);
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-patch-1",
                type: "function",
                function: { name: "proposePatch", arguments: JSON.stringify({}) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [{ message: { role: "assistant", content: "Patch generated." } }]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Change code",
    registry,
    runId: "test-runtime-generated-patch",
    requestCompletion: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.deepEqual(result.generatedPatchIds, ["patch-runtime-1"]);
});

test("agent runtime direct edit tools do not create pending patch ids", async () => {
  const registry = createAgentToolRegistry([
    {
      name: "replaceInFile",
      description: "Directly edit a file",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: true
      },
      async execute() {
        // 直写工具代表第五阶段主链路：文件已经由工具落盘，不再生成待审 patch。
        return {
          filePath: "src/app.ts",
          changed: true,
          replacements: 1,
          oldContentPreview: "const title = 'old';",
          finalContent: "const title = 'new';",
          checkpointId: "checkpoint-direct-1"
        };
      },
      summarize(value, cached) {
        return { cached, value };
      }
    }
  ]);
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-direct-edit-1",
                type: "function",
                function: { name: "replaceInFile", arguments: JSON.stringify({ filePath: "src/app.ts", search: "old", replace: "new" }) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [{ message: { role: "assistant", content: "已直接修改文件。" } }]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "修改标题",
    registry,
    runId: "test-runtime-direct-edit-no-patch",
    mode: "act",
    requestCompletion: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.generatedPatchIds, []);
  assert.match(result.messages.find((message) => message.role === "tool")?.content || "", /finalContent/);
});

test("agent runtime default budget allows more than eight tool rounds", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [], (runtime) => {
    // 长任务只有持续获得新文件时才应继续占用完整工具预算。
    runtime.agentContext.searchResultFiles.push(`src/result-${runtime.agentContext.searchResultFiles.length + 1}.ts`);
  })]);
  const requests: Record<string, unknown>[] = [];
  let callCount = 0;

  const result = await runAgentRuntime({
    userRequest: "Search a larger codebase",
    registry,
    runId: "test-runtime-default-budget",
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;

      if (callCount <= 9) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `tool-search-${callCount}`,
                    type: "function",
                    function: { name: "searchCode", arguments: JSON.stringify({ query: `keyword-${callCount}` }) }
                  }
                ]
              }
            }
          ]
        };
      }

      return {
        choices: [{ message: { role: "assistant", content: "Finished after extended search." } }]
      };
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.content, "Finished after extended search.");
  assert.equal(requests.length, 10);
});

test("agent runtime warns the model before the tool budget is exhausted", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const requests: Record<string, unknown>[] = [];
  let callCount = 0;

  const result = await runAgentRuntime({
    userRequest: "Search until nearly limited",
    registry,
    runId: "test-runtime-budget-warning",
    maxSteps: 3,
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;

      if (callCount <= 2) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `tool-budget-${callCount}`,
                    type: "function",
                    function: { name: "searchCode", arguments: JSON.stringify({ query: `budget-${callCount}` }) }
                  }
                ]
              }
            }
          ]
        };
      }

      return {
        choices: [{ message: { role: "assistant", content: "Stopped after warning." } }]
      };
    }
  });

  const hasBudgetWarning = requests.some((request) =>
    ((request.messages as Array<{ content?: string }> | undefined) || []).some((message) => message.content?.includes("预算收敛区间"))
  );

  assert.equal(result.status, "completed");
  assert.equal(hasBudgetWarning, true);
});

test("agent budget configuration validates all threshold relationships", () => {
  assert.deepEqual(resolveAgentBudgetPolicy({
    AI_AGENT_MAX_STEPS: "30",
    AI_AGENT_CONVERGENCE_REMAINING_STEPS: "5",
    AI_AGENT_FORCE_FINAL_REMAINING_STEPS: "2"
  }), {
    maxSteps: 30,
    convergenceRemainingSteps: 5,
    forceFinalRemainingSteps: 2
  });

  // 阈值相等、顺序颠倒或非正整数都会整体回退，避免只修正单项后产生隐蔽配置。
  assert.deepEqual(resolveAgentBudgetPolicy({
    AI_AGENT_MAX_STEPS: "3",
    AI_AGENT_CONVERGENCE_REMAINING_STEPS: "3",
    AI_AGENT_FORCE_FINAL_REMAINING_STEPS: "0"
  }), {
    maxSteps: 24,
    convergenceRemainingSteps: 3,
    forceFinalRemainingSteps: 1
  });
});

test("agent runtime dynamically narrows tools while keeping precise edit and verification tools", async () => {
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("searchFilesByName", []),
    createRuntimeTestTool("searchCode", []),
    createRuntimeTestTool("searchCodeRegex", []),
    createRuntimeTestTool("searchWeb", []),
    createRuntimeTestTool("readFile", { filePath: "src/app.ts", content: "export {}" }),
    createRuntimeTestTool("proposePatch", { patchId: "patch-1" }),
    createRuntimeTestTool("replaceInFile", { changed: true }),
    createRuntimeTestTool("writeFile", { changed: true }),
    createRuntimeTestTool("runCommand", { exitCode: 0 })
  ]);
  const requests: Record<string, unknown>[] = [];
  let completionCount = 0;

  const result = await runAgentRuntime({
    userRequest: "完成实现并验证",
    registry,
    maxSteps: 4,
    convergenceRemainingSteps: 3,
    forceFinalRemainingSteps: 1,
    requestCompletion: async (body) => {
      requests.push(body);
      completionCount += 1;
      if (completionCount <= 2) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `precise-read-${completionCount}`,
                type: "function",
                function: { name: "readFile", arguments: JSON.stringify({ filePath: `src/app-${completionCount}.ts` }) }
              }]
            }
          }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "已完成收敛处理。" } }] };
    }
  });

  const normalTools = ((requests[0].tools as Array<{ function: { name: string } }>) || []).map((tool) => tool.function.name);
  const convergenceTools = ((requests[1].tools as Array<{ function: { name: string } }>) || []).map((tool) => tool.function.name);
  assert.equal(result.status, "incomplete");
  assert.equal(normalTools.includes("searchCode"), true);
  assert.equal(convergenceTools.includes("searchFilesByName"), false);
  assert.equal(convergenceTools.includes("searchCode"), false);
  assert.equal(convergenceTools.includes("searchCodeRegex"), false);
  assert.equal(convergenceTools.includes("searchWeb"), false);
  assert.equal(convergenceTools.includes("readFile"), true);
  assert.equal(convergenceTools.includes("proposePatch"), true);
  assert.equal(convergenceTools.includes("replaceInFile"), true);
  assert.equal(convergenceTools.includes("writeFile"), true);
  assert.equal(convergenceTools.includes("runCommand"), true);
});

test("agent runtime hard-blocks hidden broad searches during convergence", async () => {
  let executions = 0;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("searchCode", [], () => { executions += 1; }),
    createRuntimeTestTool("readFile", { content: "ok" })
  ]);
  const requests: Record<string, unknown>[] = [];
  let completionCount = 0;

  const result = await runAgentRuntime({
    userRequest: "不要浪费剩余预算",
    registry,
    maxSteps: 3,
    convergenceRemainingSteps: 2,
    forceFinalRemainingSteps: 1,
    requestCompletion: async (body) => {
      requests.push(body);
      completionCount += 1;
      if (completionCount <= 2) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `broad-search-${completionCount}`,
                type: "function",
                function: { name: "searchCode", arguments: JSON.stringify({ query: `query-${completionCount}` }) }
              }]
            }
          }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "已停止搜索并给出结论。" } }] };
    }
  });

  const convergenceTools = ((requests[1].tools as Array<{ function: { name: string } }>) || []).map((tool) => tool.function.name);
  assert.equal(result.status, "completed");
  assert.equal(executions, 1);
  assert.equal(convergenceTools.includes("searchCode"), false);
  assert.match(result.messages.find((message) => message.role === "tool" && message.toolCallId === "broad-search-2")?.content || "", /convergence_tool_call_blocked/);
});

test("agent runtime forces the final request without tools and prioritizes pending patch context", async () => {
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("readFile", { filePath: "src/app.ts", content: "export {}" }),
    createRuntimeTestTool("searchCode", [])
  ]);
  const requests: Record<string, unknown>[] = [];
  let completionCount = 0;

  const result = await runAgentRuntime({
    userRequest: "总结补丁",
    registry,
    generatedPatchIds: ["patch-existing"],
    maxSteps: 2,
    forceFinalRemainingSteps: 1,
    requestCompletion: async (body) => {
      requests.push(body);
      completionCount += 1;
      return completionCount === 1
        ? {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "final-read",
                  type: "function",
                  function: { name: "readFile", arguments: JSON.stringify({ filePath: "src/app.ts" }) }
                }]
              }
            }]
          }
        : { choices: [{ message: { role: "assistant", content: "补丁已生成，等待审核。" } }] };
    }
  });

  const finalRequest = requests[1];
  const finalMessages = finalRequest.messages as Array<{ content?: string }>;
  assert.equal(result.status, "awaiting_approval");
  assert.equal(finalRequest.tool_choice, "none");
  assert.deepEqual(finalRequest.tools, []);
  assert.equal(finalMessages.some((message) => message.content?.includes("待审核补丁")), true);
  assert.equal(finalMessages.some((message) => message.content?.includes("工具调用已被 Runtime 禁用")), true);
});

test("agent runtime prevents a provider from bypassing the force-final tool ban", async () => {
  let executions = 0;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("searchCode", [], () => { executions += 1; })
  ]);
  let capturedRequest: Record<string, unknown> | undefined;

  const result = await runAgentRuntime({
    userRequest: "立即给出结论",
    registry,
    maxSteps: 1,
    requestCompletion: async (body) => {
      capturedRequest = body;
      return {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "forbidden-final-search",
              type: "function",
              function: { name: "searchCode", arguments: JSON.stringify({ query: "again" }) }
            }]
          }
        }]
      };
    }
  });

  assert.equal(capturedRequest?.tool_choice, "none");
  assert.deepEqual(capturedRequest?.tools, []);
  assert.equal(executions, 0);
  assert.equal(result.status, "step_limit_reached");
  assert.match(result.content, /未完成原因/);
  assert.match(result.content, /硬性拦截/);
});

test("agent runtime warns on repeated tool calls with the same arguments", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const requests: Record<string, unknown>[] = [];
  let callCount = 0;

  const result = await runAgentRuntime({
    userRequest: "Repeat search",
    registry,
    runId: "test-runtime-repeated-tool-warning",
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;

      if (callCount <= 2) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `tool-repeat-${callCount}`,
                    type: "function",
                    function: { name: "searchCode", arguments: JSON.stringify({ query: "same-keyword" }) }
                  }
                ]
              }
            }
          ]
        };
      }

      return {
        choices: [{ message: { role: "assistant", content: "Used previous result." } }]
      };
    }
  });

  const hasRepeatedWarning = requests.some((request) =>
    ((request.messages as Array<{ content?: string }> | undefined) || []).some((message) => message.content?.includes("repeated these tool calls"))
  );

  assert.equal(result.status, "completed");
  assert.equal(hasRepeatedWarning, true);
});

test("agent runtime blocks the third identical tool call and can finish with another tool", async () => {
  let searchExecutions = 0;
  let listExecutions = 0;
  let capturedMetrics: RunMetrics | undefined;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("searchCode", [{ filePath: "src/a.ts" }], () => { searchExecutions += 1; }),
    createRuntimeTestTool("listFiles", ["src/a.ts"], () => { listExecutions += 1; })
  ]);
  let modelStep = 0;
  const steps: AgentStep[] = [];

  const result = await runAgentRuntime({
    userRequest: "Repeat search then switch strategy",
    registry,
    runId: "test-runtime-repeated-tool-block",
    onAgentStep(step) {
      steps.push(step);
    },
    metricsRecorder: async (metrics) => { capturedMetrics = metrics; },
    requestCompletion: async () => {
      modelStep += 1;
      if (modelStep <= 4) {
        // 第二次故意调整嵌套 JSON 字段顺序，验证稳定签名仍能识别为相同调用。
        const rawArguments = modelStep === 2
          ? '{"options":{"caseSensitive":false,"limit":20},"query":"same-keyword"}'
          : '{"query":"same-keyword","options":{"limit":20,"caseSensitive":false}}';
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `tool-repeat-block-${modelStep}`,
                type: "function",
                function: { name: "searchCode", arguments: rawArguments }
              }]
            }
          }]
        };
      }

      if (modelStep === 5) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: "tool-list-after-block",
                type: "function",
                function: { name: "listFiles", arguments: "{}" }
              }]
            }
          }]
        };
      }

      return { choices: [{ message: { role: "assistant", content: "Completed with another tool." } }] };
    }
  });

  const blockedResults = result.messages
    .filter((message) => message.role === "tool" && typeof message.content === "string")
    .map((message) => JSON.parse(message.content as string) as Record<string, unknown>)
    .filter((content) => content.error === "repeated_tool_call_blocked");

  assert.equal(result.status, "completed");
  assert.equal(result.content, "Completed with another tool.");
  assert.equal(searchExecutions, 1);
  assert.equal(listExecutions, 1);
  assert.deepEqual(blockedResults.map((content) => content.repeatCount), [3, 4]);
  assert.equal(blockedResults.every((content) => content.toolName === "searchCode" && content.cached === true), true);
  assert.equal(blockedResults.every((content) => typeof content.instruction === "string"), true);
  assert.equal(capturedMetrics?.tools.cacheHits, 1);
  assert.equal(capturedMetrics?.tools.failedCalls, 0);
  assert.equal(capturedMetrics?.result.failureCategory, "none");
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "repeated_tool_warning"), true);
  assert.equal(steps.filter((step) => step.type === "strategy" && step.event === "repeated_tool_blocked").length, 2);
});

test("agent runtime does not block calls with different arguments", async () => {
  let executions = 0;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("searchCode", [], () => { executions += 1; })
  ]);
  let modelStep = 0;

  const result = await runAgentRuntime({
    userRequest: "Search different terms",
    registry,
    runId: "test-runtime-distinct-tool-calls",
    metricsRecorder: async () => undefined,
    requestCompletion: async () => {
      modelStep += 1;
      if (modelStep <= 2) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `tool-distinct-${modelStep}`,
                type: "function",
                function: { name: "searchCode", arguments: JSON.stringify({ query: `keyword-${modelStep}` }) }
              }]
            }
          }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "Both searches completed." } }] };
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(executions, 2);
  assert.equal(result.messages.some((message) => typeof message.content === "string" && message.content.includes("repeated_tool_call_blocked")), false);
});

test("repeat tool-call thresholds require positive ordered integers", () => {
  assert.deepEqual(resolveAgentRepeatToolCallThresholds({
    AI_AGENT_REPEAT_WARNING_THRESHOLD: "3",
    AI_AGENT_REPEAT_BLOCK_THRESHOLD: "5"
  }), { warning: 3, block: 5 });
  assert.deepEqual(resolveAgentRepeatToolCallThresholds({
    AI_AGENT_REPEAT_WARNING_THRESHOLD: "0",
    AI_AGENT_REPEAT_BLOCK_THRESHOLD: "not-a-number"
  }), { warning: 2, block: 3 });
  assert.deepEqual(resolveAgentRepeatToolCallThresholds({
    AI_AGENT_REPEAT_WARNING_THRESHOLD: "4",
    AI_AGENT_REPEAT_BLOCK_THRESHOLD: "4"
  }), { warning: 2, block: 3 });
});

test("no-progress policy validates the threshold and recovery attempts", () => {
  assert.deepEqual(resolveAgentNoProgressPolicy({
    AI_AGENT_MAX_NO_PROGRESS_STEPS: "6",
    AI_AGENT_RECOVERY_ATTEMPTS: "2"
  }), { maxSteps: 6, recoveryAttempts: 2 });
  assert.deepEqual(resolveAgentNoProgressPolicy({
    AI_AGENT_MAX_NO_PROGRESS_STEPS: "0",
    AI_AGENT_RECOVERY_ATTEMPTS: "-1"
  }), { maxSteps: 4, recoveryAttempts: 1 });
  assert.deepEqual(resolveAgentNoProgressPolicy({
    AI_AGENT_MAX_NO_PROGRESS_STEPS: "3",
    AI_AGENT_RECOVERY_ATTEMPTS: "0"
  }), { maxSteps: 3, recoveryAttempts: 0 });
});

test("agent runtime recovers once and then stops after another no-progress window", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const requests: Record<string, unknown>[] = [];
  let modelStep = 0;
  let capturedMetrics: RunMetrics | undefined;
  const steps: AgentStep[] = [];

  const result = await runAgentRuntime({
    userRequest: "Search without making progress",
    registry,
    maxNoProgressSteps: 2,
    recoveryAttempts: 1,
    onAgentStep(step) {
      steps.push(step);
    },
    metricsRecorder: async (metrics) => { capturedMetrics = metrics; },
    requestCompletion: async (body) => {
      requests.push(body);
      modelStep += 1;
      return {
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `no-progress-${modelStep}`,
              type: "function",
              function: { name: "searchCode", arguments: JSON.stringify({ query: `missing-${modelStep}` }) }
            }]
          }
        }]
      };
    }
  });

  const recoveryPrompt = requests[2]?.messages as Array<{ role: string; content?: string }>;
  assert.equal(result.status, "no_progress");
  assert.match(result.content, /连续工具调用未取得进展/);
  assert.match(result.content, /模型轮次：4\/24/);
  assert.match(result.content, /工具调用：4/);
  assert.match(result.content, /建议下一步/);
  assert.equal(modelStep, 4);
  assert.equal(recoveryPrompt.some((message) => message.content?.includes("策略恢复")), true);
  assert.equal(capturedMetrics?.tools.recoveryAttempts, 1);
  assert.equal(capturedMetrics?.tools.maxConsecutiveNoProgressSteps, 2);
  assert.equal(capturedMetrics?.result.stopReason, "no_progress");
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "no_progress_recovery"), true);
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "no_progress_stop"), true);
});

test("newly discovered files reset the no-progress counter", async () => {
  let execution = 0;
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [], (runtime) => {
    execution += 1;
    if (execution === 2) runtime.agentContext.searchResultFiles.push("src/new-result.ts");
  })]);
  const requests: Record<string, unknown>[] = [];
  let modelStep = 0;

  const result = await runAgentRuntime({
    userRequest: "Discover a file between empty searches",
    registry,
    maxNoProgressSteps: 2,
    recoveryAttempts: 1,
    requestCompletion: async (body) => {
      requests.push(body);
      modelStep += 1;
      if (modelStep <= 4) {
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `progress-reset-${modelStep}`,
                type: "function",
                function: { name: "searchCode", arguments: JSON.stringify({ query: `query-${modelStep}` }) }
              }]
            }
          }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "Changed strategy after discovery." } }] };
    }
  });

  // 若第二次调用没有重置计数，恢复提示会在第三次模型请求前出现。
  const thirdRequestMessages = requests[2]?.messages as Array<{ content?: string }>;
  const fifthRequestMessages = requests[4]?.messages as Array<{ content?: string }>;
  assert.equal(result.status, "completed");
  assert.equal(thirdRequestMessages.some((message) => message.content?.includes("策略恢复")), false);
  assert.equal(fifthRequestMessages.some((message) => message.content?.includes("策略恢复")), true);
});

test("new negative evidence counts as progress even when the search result is empty", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchFilesByName", {
    matches: [],
    conclusion: "target_absent"
  }, (runtime) => {
    runtime.agentContext.negativeEvidence = [{
      kind: "path_absent",
      query: "router",
      scope: "src",
      sourceTool: "searchFilesByName",
      exhaustive: true,
      createdAt: Date.now()
    }];
  })]);
  let modelStep = 0;
  const steps: AgentStep[] = [];

  const result = await runAgentRuntime({
    userRequest: "Confirm router absence",
    registry,
    maxNoProgressSteps: 1,
    recoveryAttempts: 0,
    onAgentStep(step) {
      steps.push(step);
    },
    requestCompletion: async () => {
      modelStep += 1;
      return modelStep === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "negative-progress", type: "function", function: { name: "searchFilesByName", arguments: "{}" } }] } }] }
        : { choices: [{ message: { role: "assistant", content: "Absence confirmed." } }] };
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(result.agentContext.negativeEvidence?.length, 1);
  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "negative_evidence"), true);
});

test("reading a new range of an existing file counts as progress", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("readFileRange", { content: "range" })]);
  let modelStep = 0;

  const result = await runAgentRuntime({
    userRequest: "Read two ranges",
    agentContext: {
      userGoal: "Read two ranges",
      filesRead: ["src/large.ts"],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: ["src/large.ts"]
    },
    registry,
    maxNoProgressSteps: 1,
    recoveryAttempts: 0,
    requestCompletion: async () => {
      modelStep += 1;
      if (modelStep <= 2) {
        const startLine = modelStep === 1 ? 1 : 101;
        return {
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: `range-progress-${modelStep}`,
                type: "function",
                function: {
                  name: "readFileRange",
                  arguments: JSON.stringify({ filePath: "src/large.ts", startLine, endLine: startLine + 99 })
                }
              }]
            }
          }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "Both ranges read." } }] };
    }
  });

  assert.equal(result.status, "completed");
  assert.equal(modelStep, 3);
});

test("generating a patch resets the no-progress counter", async () => {
  const registry = createAgentToolRegistry([{
    name: "proposePatch",
    description: "Generate a test patch",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async execute(_args, runtime) {
      runtime.generatedPatchIds?.push("progress-patch");
      return { patchId: "progress-patch" };
    },
    summarize(value, cached) {
      return { cached, value };
    }
  }]);
  let modelStep = 0;

  const result = await runAgentRuntime({
    userRequest: "Generate patch",
    registry,
    maxNoProgressSteps: 1,
    recoveryAttempts: 0,
    requestCompletion: async () => {
      modelStep += 1;
      return modelStep === 1
        ? { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "patch-progress", type: "function", function: { name: "proposePatch", arguments: "{}" } }] } }] }
        : { choices: [{ message: { role: "assistant", content: "Patch generated." } }] };
    }
  });

  assert.equal(result.status, "awaiting_approval");
  assert.deepEqual(result.generatedPatchIds, ["progress-patch"]);
});

test("agent runtime pauses before approval-required tools", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const steps: Array<{ type: string; status?: string; actionType?: string }> = [];

  const result = await runAgentRuntime({
    userRequest: "Run tests",
    registry,
    runId: "test-runtime-approval",
    agentContext: { userGoal: "Run tests", filesRead: ["src/service.ts"], searchQueries: [], searchResultFiles: [], relevantFiles: ["src/service.ts"] },
    onAgentStep(step) {
      steps.push({ type: step.type, status: step.type === "approval_request" ? step.status : undefined, actionType: step.type === "approval_request" ? step.actionType : undefined });
    },
    requestCompletion: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-command-1",
                type: "function",
                function: { name: "runCommand", arguments: JSON.stringify({ command: "pnpm test" }) }
              }
            ]
          }
        }
      ]
    })
  });
  // Stop at the first approval-required tool; later tools are neither shown nor executed early.
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.pendingToolCall?.toolName, "runCommand");
  assert.equal(result.pendingToolCall?.riskLevel, "medium");
  assert.deepEqual(result.pendingToolCall?.agentContext?.filesRead, ["src/service.ts"]);
  assert.equal(result.completionEvidence?.pendingApprovalCount, 1);
  assert.match(result.statusReason ?? "", /等待用户审批/);
  assert.equal(executed, false);
  assert.deepEqual(steps, [{ type: "approval_request", status: "pending", actionType: "run_command" }]);
});

test("agent runtime emits no approval cards for auto-approved tools", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("readFile", { filePath: "src/a.ts", content: "hello" })]);
  const steps: Array<{ type: string; status?: string }> = [];
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-read-auto",
                type: "function",
                function: { name: "readFile", arguments: JSON.stringify({ filePath: "src/a.ts" }) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [{ message: { role: "assistant", content: "Read completed." } }]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Read a file",
    registry,
    runId: "test-runtime-auto-tool-no-approval-card",
    onAgentStep(step) {
      steps.push({ type: step.type, status: step.type === "approval_request" ? step.status : undefined });
    },
    requestCompletion: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  // Auto-approved context tools should not occupy the manual approval UI.
  assert.equal(result.status, "completed");
  assert.equal(steps.some((step) => step.type === "approval_request"), false);
});

test("agent runtime exposes only the first pending approval from a tool batch", async () => {
  let runCommandExecuted = false;
  let applyPatchExecuted = false;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (runCommandExecuted = true)),
    createRuntimeTestTool("applyPatch", { files: [] }, () => (applyPatchExecuted = true))
  ]);
  const steps: Array<{ type: string; actionType?: string; status?: string }> = [];

  const result = await runAgentRuntime({
    userRequest: "Run two risky tools",
    registry,
    runId: "test-runtime-one-pending-approval",
    onAgentStep(step) {
      steps.push({ type: step.type, actionType: step.type === "approval_request" ? step.actionType : undefined, status: step.type === "approval_request" ? step.status : undefined });
    },
    requestCompletion: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-command-first",
                type: "function",
                function: { name: "runCommand", arguments: JSON.stringify({ command: "pnpm test" }) }
              },
              {
                id: "tool-patch-second",
                type: "function",
                function: { name: "applyPatch", arguments: JSON.stringify({ patchId: "patch-1" }) }
              }
            ]
          }
        }
      ]
    })
  });

  // Cline 濡炲瀛╅悧鎼佸及椤栫偘娴烽柛鎺撳椤戝洦绋夐埀顒佺▔椤忓嫮绐￠悗鍏夊墲婢规帒顔忛妷銉ュ緮閻忓繗椴稿▓蹇涘磻濠婃劗绀夐柛姘捣閻㈣顔忛妷銉ュ緮濞戞挸绉崇槐浼村箵閹邦剙顤呴悘鐐存礈閵囨岸骞嬮弽銊モ挃閻炴稑琚埀?
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.pendingToolCall?.toolName, "runCommand");
  assert.equal(runCommandExecuted, false);
  assert.equal(applyPatchExecuted, false);
  assert.deepEqual(steps, [{ type: "approval_request", actionType: "run_command", status: "pending" }]);
});

test("agent runtime feeds blocked unknown tools back to the model", async () => {
  const registry = createAgentToolRegistry([]);
  let capturedMetrics: RunMetrics | undefined;
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "unknown-tool-1",
                type: "function",
                function: { name: "missingTool", arguments: JSON.stringify({}) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Cannot use that tool, so I will stop."
          }
        }
      ]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Call unknown tool",
    registry,
    runId: "test-runtime-blocked-tool",
    metricsRecorder: async (metrics) => { capturedMetrics = metrics; },
    requestCompletion: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.equal(result.status, "completed");
  assert.match(result.messages.find((message) => message.role === "tool")?.content || "", /Unknown tool/);
  assert.equal(result.content, "Cannot use that tool, so I will stop.");
  assert.equal(capturedMetrics?.tools.invalidToolCalls, 1);
  assert.equal(capturedMetrics?.tools.maxConsecutiveNoProgressSteps, 1);
});

test("agent runtime blocks prohibited runCommand before approval", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const responses: AgentCompletionResponse[] = [
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "tool-command-blocked",
                type: "function",
                function: { name: "runCommand", arguments: JSON.stringify({ command: "rm -rf dist" }) }
              }
            ]
          }
        }
      ]
    },
    {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Command was blocked, so I will not run it."
          }
        }
      ]
    }
  ];

  const result = await runAgentRuntime({
    userRequest: "Run dangerous command",
    registry,
    runId: "test-runtime-blocked-command",
    requestCompletion: async () => {
      const response = responses.shift();
      assert.ok(response);
      return response;
    }
  });

  assert.equal(executed, false);
  assert.equal(result.status, "completed");
  assert.match(result.messages.find((message) => message.role === "tool")?.content || "", /blocked pattern/);
  assert.equal(result.content, "Command was blocked, so I will not run it.");
});

test("agent runtime resumes after approving a pending tool call", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const result = await resumeAgentRuntimeAfterApproval({
    userRequest: "Run tests",
    registry,
    runId: "test-runtime-resume-approved",
    pendingToolCall: {
      actionId: "run_command:test-action",
      toolCallId: "tool-command-1",
      toolName: "runCommand",
      arguments: { command: "pnpm test" },
      riskLevel: "medium",
      status: "pending",
      createdAt: Date.now()
    },
    persistedMessages: [
      {
        id: "assistant-tool-call",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tool-command-1", name: "runCommand", arguments: { command: "pnpm test" } }],
        createdAt: Date.now()
      }
    ],
    decision: "approved",
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "Command result handled." } }]
    })
  });

  assert.equal(executed, true);
  assert.equal(result.status, "completed");
  assert.equal(result.content, "Command result handled.");
  assert.equal(result.messages.some((message) => message.role === "tool" && /exitCode/.test(message.content || "")), true);
});

test("agent runtime resumes after rejecting a pending tool call", async () => {
  let executed = false;
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, () => (executed = true))]);
  const result = await resumeAgentRuntimeAfterApproval({
    userRequest: "Run tests",
    registry,
    runId: "test-runtime-resume-rejected",
    pendingToolCall: {
      actionId: "run_command:test-action",
      toolCallId: "tool-command-1",
      toolName: "runCommand",
      arguments: { command: "pnpm test" },
      riskLevel: "medium",
      status: "pending",
      createdAt: Date.now()
    },
    persistedMessages: [
      {
        id: "assistant-tool-call",
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tool-command-1", name: "runCommand", arguments: { command: "pnpm test" } }],
        createdAt: Date.now()
      }
    ],
    decision: "rejected",
    requestCompletion: async () => ({
      choices: [{ message: { role: "assistant", content: "I will continue without that command." } }]
    })
  });

  assert.equal(executed, false);
  assert.equal(result.status, "completed");
  assert.equal(result.content, "I will continue without that command.");
  assert.match(result.messages.find((message) => message.role === "tool")?.content || "", /rejected/);
});

test("agent runtime stops when tool-call step limit is reached", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const steps: AgentStep[] = [];
  let capturedMetrics: RunMetrics | undefined;

  const result = await runAgentRuntime({
    userRequest: "Search code",
    registry,
    runId: "test-runtime-limit",
    maxSteps: 2,
    metricsRecorder: async (metrics) => { capturedMetrics = metrics; },
    onAgentStep(step) {
      steps.push(step);
    },
    requestCompletion: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `tool-${Date.now()}-${Math.random()}`,
                type: "function",
                function: { name: "searchCode", arguments: JSON.stringify({ query: "Agent" }) }
              }
            ]
          }
        }
      ]
    })
  });

  assert.equal(result.status, "step_limit_reached");
  assert.match(result.content, /已用完 2 个模型步骤/);
  assert.match(result.content, /未完成原因/);
  assert.equal(steps.some((step) => step.type === "error" && step.message.includes("已停止新的工具调用")), true);
  assert.equal(capturedMetrics?.result.stopReason, "step_limit");
  assert.equal(capturedMetrics?.tools.repeatedCalls, 1);
  assert.equal(capturedMetrics?.tools.cacheHits, 0);
  assert.equal(capturedMetrics?.tools.emptyResults, 1);
  assert.deepEqual(capturedMetrics?.tools.mostRepeatedCall, {
    toolName: "searchCode",
    signature: 'searchCode:{"query":"Agent"}',
    calls: 2,
    repeatedCalls: 1,
    firstStep: 1,
    lastStep: 2,
    allResultsEmpty: false,
    cacheHit: false
  });
});

test("agent runtime restores Safe Editor context after approval", async () => {
  let restoredFilesRead: string[] = [];
  const registry = createAgentToolRegistry([createRuntimeTestTool("runCommand", { exitCode: 0 }, (runtime) => { restoredFilesRead = runtime.agentContext.filesRead; })]);
  await resumeAgentRuntimeAfterApproval({
    userRequest: "Run tests",
    registry,
    pendingToolCall: {
      actionId: "run_command:restore-context", toolCallId: "tool-restore-context", toolName: "runCommand", arguments: { command: "pnpm test" }, riskLevel: "medium", status: "pending", createdAt: Date.now(),
      agentContext: { userGoal: "Run tests", filesRead: ["src/service.ts"], searchQueries: ["impact:src/service.ts"], searchResultFiles: [], relevantFiles: ["src/service.ts"] }
    },
    decision: "approved",
    requestCompletion: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }] })
  });

  assert.deepEqual(restoredFilesRead, ["src/service.ts"]);
});

test("审批恢复后保留 applyPatch 的已落盘文件证据", async () => {
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("applyPatch", {
      patchId: "patch-approved",
      files: [{ path: "src/service.ts", status: "modify" }],
      checkpointId: "checkpoint-approved"
    })
  ]);
  const result = await resumeAgentRuntimeAfterApproval({
    userRequest: "修改 src/service.ts",
    mode: "act",
    registry,
    pendingToolCall: {
      actionId: "apply_patch:approved",
      toolCallId: "tool-apply-approved",
      toolName: "applyPatch",
      arguments: { patchId: "patch-approved" },
      riskLevel: "medium",
      status: "pending",
      createdAt: Date.now()
    },
    decision: "approved",
    contextBudgetEnabled: false,
    requestCompletion: async () => ({ choices: [{ message: { role: "assistant", content: "补丁已应用。" } }] }),
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
});

test("审批恢复会合并此前文件证据与本次验证时间", async () => {
  const validationFinishedAt = 300;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("runCommand", { exitCode: 0 }, (runtime) => {
      runtime.agentContext.commandsRun = [{
        command: "pnpm test",
        status: "success",
        exitCode: 0,
        validation: true,
        finishedAt: validationFinishedAt
      }];
    }),
    ...completionAgentToolDefinitions
  ]);
  const result = await resumeAgentRuntimeAfterApproval({
    userRequest: "修改 src/a.ts 并验证",
    mode: "act",
    registry,
    runtimeEvidence: {
      taskRunId: "task-run-evidence",
      appliedFilePaths: ["src/a.ts"],
      generatedPatchIds: [],
      lastMutationAt: 100
    },
    pendingToolCall: {
      actionId: "run_command:evidence",
      toolCallId: "tool-validation-evidence",
      toolName: "runCommand",
      arguments: { command: "pnpm test" },
      riskLevel: "medium",
      status: "pending",
      createdAt: Date.now()
    },
    decision: "approved",
    contextBudgetEnabled: false,
    explicitCompletionRollout: { mode: "all" },
    requestCompletion: async () => ({ choices: [{ message: { role: "assistant", content: null, tool_calls: [
      createModelToolCall("complete-after-validation", "completeTask", { summary: "修改与验证完成", verified: true, validationSummary: "测试通过" })
    ] } }] }),
    metricsRecorder: async () => undefined
  });

  assert.equal(result.status, "completed");
  assert.equal(result.completionEvidence?.changedFileCount, 1);
  assert.equal(result.completionEvidence?.validationStatus, "passed");
  assert.equal(result.runtimeEvidence.taskRunId, "task-run-evidence");
  assert.deepEqual(result.runtimeEvidence.generatedPatchIds, []);
  assert.equal(result.runtimeEvidence.lastValidationAt, validationFinishedAt);
});

test("agent runtime emits a visible budget warning step before exhausting tool budget", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const steps: AgentStep[] = [];

  await runAgentRuntime({
    userRequest: "Search until budget warning",
    registry,
    runId: "test-runtime-visible-budget-warning",
    maxSteps: 4,
    onAgentStep(step) {
      steps.push(step);
    },
    requestCompletion: async () => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `tool-budget-visible-${Date.now()}-${Math.random()}`,
                type: "function",
                function: { name: "searchCode", arguments: JSON.stringify({ query: "Agent" }) }
              }
            ]
          }
        }
      ]
    })
  });

  assert.equal(steps.some((step) => step.type === "strategy" && step.event === "budget_convergence"), true);
});

test("plan mode exposes only readonly tools to the model", async () => {
  const requests: Record<string, unknown>[] = [];

  const result = await runAgentRuntime({
    userRequest: "Plan a change",
    runId: "test-runtime-plan-mode",
    mode: "plan",
    requestCompletion: async (body) => {
      requests.push(body);
      return {
        choices: [{ message: { role: "assistant", content: null, tool_calls: [
          createModelToolCall("complete-plan", "completeTask", { summary: "Plan completed.", verified: true })
        ] } }]
      };
    }
  });

  const toolNames = ((requests[0].tools as Array<{ function: { name: string } }>) || []).map((tool) => tool.function.name);
  assert.equal(result.status, "completed");
  // Symbol Graph 和 External Context Gateway 都是只读上下文能力，因此规划模式也应允许使用。
  assert.deepEqual(toolNames.sort(), ["analyzeImpact", "analyzeSymbolGraph", "browseWebPage", "checkExistence", "completeTask", "fetchApiDocs", "findSimilarPatterns", "getExternalContextStatus", "inspectProject", "listCodeDefinitionNames", "listFiles", "readFile", "readFileChunk", "readFileRange", "recoverContextArtifact", "searchCode", "searchCodeRegex", "searchFilesByName", "searchOfficialDocs", "searchWeb", "sequenceReasoning"].sort());
});

test("act mode exposes edit, patch, and command tools to the model", async () => {
  const requests: Record<string, unknown>[] = [];

  const result = await runAgentRuntime({
    userRequest: "Implement a change",
    runId: "test-runtime-act-mode",
    mode: "act",
    requestCompletion: async (body) => {
      requests.push(body);
      return {
        choices: [{ message: { role: "assistant", content: "Act completed." } }]
      };
    }
  });

  const toolNames = ((requests[0].tools as Array<{ function: { name: string } }>) || []).map((tool) => tool.function.name);
  assert.equal(result.status, "incomplete");
  assert.equal(toolNames.includes("replaceInFile"), true);
  assert.equal(toolNames.includes("writeFile"), true);
  assert.equal(toolNames.includes("proposePatch"), true);
  assert.equal(toolNames.includes("applyPatch"), true);
  assert.equal(toolNames.includes("runCommand"), true);
  assert.equal(toolNames.includes("automateBrowser"), true);
  // patch 工具排在直接编辑工具前面，引导常规修改先进入 diff 审核。
  assert.ok(toolNames.indexOf("proposePatch") < toolNames.indexOf("replaceInFile"));
  assert.ok(toolNames.indexOf("applyPatch") < toolNames.indexOf("writeFile"));
});

test("act mode blocks edits until Pattern Finder has been called", async () => {
  let requestCount = 0;
  const result = await runAgentRuntime({
    userRequest: "实现一个新服务",
    runId: "test-runtime-pattern-finder-gate",
    mode: "act",
    requestCompletion: async () => {
      requestCount += 1;
      return requestCount === 1
        ? { choices: [{ message: { role: "assistant", tool_calls: [{ id: "patch-before-pattern", type: "function", function: { name: "proposePatch", arguments: "{}" } }] } }] }
        : { choices: [{ message: { role: "assistant", content: "已收到检索要求。" } }] };
    }
  });

  const blockedToolMessage = result.messages.find((message) => message.role === "tool" && message.toolCallId === "patch-before-pattern");
  assert.match(blockedToolMessage?.content || "", /findSimilarPatterns/);
});

test("act prompt 优先引导生成可审查 patch", () => {
  assert.match(AI_AGENT_ACT_SYSTEM_PROMPT, /use proposePatch as the default path/i);
  assert.match(AI_AGENT_ACT_SYSTEM_PROMPT, /inspect the diff before applying changes/i);
  assert.match(AI_AGENT_ACT_SYSTEM_PROMPT, /Use replaceInFile only when the user explicitly asks for direct edits/i);
  assert.match(AI_AGENT_ACT_SYSTEM_PROMPT, /treat finalContent from the tool result as the latest source of truth/i);
  assert.match(AI_AGENT_ACT_SYSTEM_PROMPT, /Use proposePatch for reviewable code changes before files are written/i);
});

test("agent runtime budget warning keeps patch review as the preferred path", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const requests: Record<string, unknown>[] = [];
  let callCount = 0;

  const result = await runAgentRuntime({
    userRequest: "Modify code",
    registry,
    runId: "test-runtime-budget-warning-direct-edit",
    maxSteps: 3,
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;

      if (callCount <= 2) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `tool-direct-edit-budget-${callCount}`,
                    type: "function",
                    function: { name: "searchCode", arguments: JSON.stringify({ query: `edit-${callCount}` }) }
                  }
                ]
              }
            }
          ]
        };
      }

      return {
        choices: [{ message: { role: "assistant", content: "Stopped after direct edit warning." } }]
      };
    }
  });

  const warningMessages = requests.flatMap((request) => (request.messages as Array<{ content?: string }> | undefined) || []).filter((message) => message.content?.includes("预算收敛区间"));
  assert.equal(result.status, "incomplete");
  assert.equal(warningMessages.some((message) => message.content?.includes("proposePatch")), true);
  assert.equal(warningMessages.some((message) => message.content?.includes("禁止继续宽泛搜索")), true);
  assert.equal(warningMessages.some((message) => message.content?.includes("必要的编辑或验证工具")), true);
});

test("agent runtime repeated-tool warning asks the model to move to patch review", async () => {
  const registry = createAgentToolRegistry([createRuntimeTestTool("searchCode", [])]);
  const requests: Record<string, unknown>[] = [];
  let callCount = 0;

  const result = await runAgentRuntime({
    userRequest: "Repeat then edit",
    registry,
    runId: "test-runtime-repeated-warning-direct-edit",
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;

      if (callCount <= 2) {
        return {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `tool-direct-edit-repeat-${callCount}`,
                    type: "function",
                    function: { name: "searchCode", arguments: JSON.stringify({ query: "same-edit-keyword" }) }
                  }
                ]
              }
            }
          ]
        };
      }

      return {
        choices: [{ message: { role: "assistant", content: "Used direct edit warning." } }]
      };
    }
  });

  const warningMessages = requests.flatMap((request) => (request.messages as Array<{ content?: string }> | undefined) || []).filter((message) => message.content?.includes("repeated these tool calls"));
  assert.equal(result.status, "incomplete");
  assert.equal(warningMessages.some((message) => message.content?.includes("move to proposePatch")), true);
  assert.equal(warningMessages.some((message) => message.content?.includes("direct-edit fallback")), true);
});

test("analysis-only workflow injects its prompt and exposes only read-only tools", async () => {
  const requests: Record<string, unknown>[] = [];
  const workflow = createTaskWorkflow("分析模块依赖", {
    intent: "inspect",
    confidence: 0.9,
    normalizedGoal: "分析模块依赖",
    reason: "test"
  });

  await runAgentRuntime({
    userRequest: "分析模块依赖",
    mode: "act",
    workflow,
    runId: "test-analysis-workflow-tools",
    requestCompletion: async (body) => {
      requests.push(body);
      return { choices: [{ message: { role: "assistant", content: "分析完成" } }] };
    }
  });

  const tools = (requests[0]?.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  const messages = requests[0]?.messages as Array<{ role: string; content?: string }>;
  assert.equal(tools.includes("proposePatch"), false);
  assert.equal(tools.includes("replaceInFile"), false);
  assert.equal(tools.includes("runCommand"), false);
  assert.match(messages[0]?.content || "", /Task workflow: analysis-only/);
  assert.equal(messages.some((message) => message.role === "system" && message.content?.includes("Workflow decision state")), true);
  assert.equal(messages.some((message) => message.content?.includes("workspace mutation allowed: false")), true);
  assert.equal(messages.slice(1).some((message) => message.role === "system"), false);
});

test("analysis-only workflow blocks side-effect tools even in a custom registry", async () => {
  let executed = false;
  let callCount = 0;
  const registry = createAgentToolRegistry([createRuntimeTestTool("replaceInFile", { changed: true }, () => { executed = true; })]);
  const workflow = createTaskWorkflow("分析模块依赖", {
    intent: "inspect",
    confidence: 0.9,
    normalizedGoal: "分析模块依赖",
    reason: "test"
  });
  const result = await runAgentRuntime({
    userRequest: "分析模块依赖",
    mode: "act",
    workflow,
    registry,
    runId: "test-analysis-workflow-block",
    requestCompletion: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "edit-1", type: "function", function: { name: "replaceInFile", arguments: "{}" } }] } }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "保持只读" } }] };
    }
  });

  assert.equal(executed, false);
  assert.equal(result.messages.some((message) => message.role === "tool" && message.content?.includes("only allows read-only")), true);
});

test("runtime 按本次 create 意图放行 proposePatch，不受无关旧缺失检查阻塞", async () => {
  let executed = false;
  let callCount = 0;
  const registry = createAgentToolRegistry([
    createRuntimeTestTool("proposePatch", { patchId: "patch-router" }, () => { executed = true; })
  ]);
  const workflow = createTaskWorkflow("新增路由文件", {
    intent: "edit",
    confidence: 0.9,
    normalizedGoal: "新增路由文件",
    reason: "test"
  });
  const steps: AgentStep[] = [];

  const result = await runAgentRuntime({
    userRequest: "新增路由文件",
    mode: "act",
    workflow,
    registry,
    agentContext: {
      userGoal: "新增路由文件",
      filesRead: ["src/main.js"],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: ["src/main.js"],
      existenceCheckPerformed: true,
      unresolvedExistenceChecks: ["import:./legacy-missing"],
      referenceChecks: {
        "[\"import\",\"./legacy-missing\",\"src/legacy.ts\",\"\"]": {
          status: "truly_missing",
          blocking: true,
          reason: "旧文件中的无关缺失",
          candidates: []
        }
      }
    },
    runId: "test-create-gate-unrelated-missing",
    onAgentStep: (step) => steps.push(step),
    requestCompletion: async () => {
      callCount += 1;
      return callCount === 1
        ? {
            choices: [{
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{
                  id: "create-router",
                  type: "function",
                  function: {
                    name: "proposePatch",
                    arguments: JSON.stringify({ filePath: "src/router/index.js", changeKind: "create" })
                  }
                }]
              }
            }]
          }
        : { choices: [{ message: { role: "assistant", content: "已生成路由补丁" } }] };
    }
  });

  assert.equal(executed, true);
  assert.deepEqual(result.generatedPatchIds, []);
  assert.equal(result.messages.some((message) => message.role === "tool" && message.content?.includes("legacy-missing")), false);
  const decision = steps.find((step): step is Extract<AgentStep, { type: "workflow_decision" }> => step.type === "workflow_decision");
  assert.equal(decision?.decision, "allowed");
  assert.deepEqual(decision?.plannedFiles, ["src/router/index.js"]);
  assert.equal(decision?.references[0]?.status, "truly_missing");
});

test("refactor workflow requires impact evidence before editing", async () => {
  let executed = false;
  let callCount = 0;
  const requests: Record<string, unknown>[] = [];
  const registry = createAgentToolRegistry([createRuntimeTestTool("proposePatch", { patchId: "patch-1" }, () => { executed = true; })]);
  const workflow = createTaskWorkflow("重构任务存储", {
    intent: "edit",
    confidence: 0.9,
    normalizedGoal: "重构任务存储",
    reason: "test"
  });
  const result = await runAgentRuntime({
    userRequest: "重构任务存储",
    workflow,
    registry,
    agentContext: {
      userGoal: "重构任务存储",
      filesRead: ["src/store.ts"],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: ["src/store.ts"]
    },
    runId: "test-refactor-workflow-impact",
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;
      if (callCount === 1) {
        return {
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "patch-1", type: "function", function: { name: "proposePatch", arguments: "{}" } }] } }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "先补影响分析" } }] };
    }
  });

  assert.equal(executed, false);
  assert.equal(result.messages.some((message) => message.role === "tool" && message.content?.includes("requires analyzeImpact")), true);
  assert.equal((requests[0]?.messages as Array<{ content?: string }>).some((message) => message.content?.includes("evidence missing before edit: impact_analysis")), true);
});

test("bugfix workflow requires a reproduction command attempt before editing", async () => {
  let executed = false;
  let callCount = 0;
  const requests: Record<string, unknown>[] = [];
  const registry = createAgentToolRegistry([createRuntimeTestTool("proposePatch", { patchId: "patch-1" }, () => { executed = true; })]);
  const workflow = createTaskWorkflow("修复登录失败", {
    intent: "diagnose_then_edit",
    confidence: 0.9,
    normalizedGoal: "修复登录失败",
    reason: "test"
  });
  const result = await runAgentRuntime({
    userRequest: "修复登录失败",
    workflow,
    registry,
    agentContext: {
      userGoal: "修复登录失败",
      filesRead: ["src/login.ts"],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: ["src/login.ts"],
      commandsRun: []
    },
    runId: "test-bugfix-workflow-reproduction",
    requestCompletion: async (body) => {
      requests.push(body);
      callCount += 1;
      if (callCount === 1) {
        return {
          choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "patch-1", type: "function", function: { name: "proposePatch", arguments: "{}" } }] } }]
        };
      }
      return { choices: [{ message: { role: "assistant", content: "先复现问题" } }] };
    }
  });

  assert.equal(executed, false);
  assert.equal(result.messages.some((message) => message.role === "tool" && message.content?.includes("command attempt")), true);
  assert.equal((requests[0]?.messages as Array<{ content?: string }>).some((message) => message.content?.includes("evidence missing before edit: command_attempt")), true);
});
