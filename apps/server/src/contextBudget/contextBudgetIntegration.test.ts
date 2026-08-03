import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentRuntime } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import { readonlyAgentToolDefinitions } from "../agentTools.js";
import { evaluateAgentToolApproval } from "../agentPermissions.js";
import { addTaskSessionFilesChanged, createTaskSession, getTaskSession, setTaskPlanItems } from "../taskSessionStore.js";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { recoverStoredContextArtifact, storeContextArtifact } from "./artifactStore.js";
import { mergeContextBudgetSession } from "../../../web/src/contextBudgetState.js";

test("原始工具结果可按引用分块恢复", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "context-artifact-recovery-"));
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await storeContextArtifact({
      taskSessionId: "task-recovery",
      toolCallId: "read-large-1",
      toolName: "readFile",
      arguments: { filePath: "src/large.ts" },
      result: { filePath: "src/large.ts", content: `BEGIN-${"x".repeat(8_000)}-END` }
    });

    const first = await recoverStoredContextArtifact({ taskSessionId: "task-recovery", reference: "tool-call:read-large-1", maxChars: 1_000 });
    const second = await recoverStoredContextArtifact({ taskSessionId: "task-recovery", reference: "tool-call:read-large-1", offset: first.nextOffset, maxChars: 1_000 });
    assert.equal(first.hasMore, true);
    assert.equal(second.offset, first.nextOffset);
    assert.notEqual(first.content, second.content);
    const recoveryDefinition = readonlyAgentToolDefinitions.find((definition) => definition.name === "recoverContextArtifact");
    assert.ok(recoveryDefinition);
    assert.equal(evaluateAgentToolApproval({ id: "recover-approval", type: "function", function: { name: "recoverContextArtifact", arguments: JSON.stringify({ reference: "tool-call:read-large-1" }) } }, recoveryDefinition).status, "auto_approved");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Runtime 使用真实计划和模型元数据，并在待审批时刷新摘要", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "context-runtime-state-"));
  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    const session = await createTaskSession("修复真实审批状态");
    await setTaskPlanItems(session.id, [
      { title: "定位失败", status: "completed" },
      { title: "修改实现", status: "in_progress" },
      { title: "运行验证", status: "blocked", note: "等待命令审批" }
    ]);
    await addTaskSessionFilesChanged(session.id, ["src/changed.ts"]);
    const budgetEvents: Array<{ summary: { pendingApproval?: { actionId: string } | null; planStatus: string[]; filesModified: string[] } | null; contextWindow: number }> = [];
    const registry = createAgentToolRegistry([{
      name: "runCommand",
      description: "需要审批的测试命令",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      async execute() { return { exitCode: 0 }; },
      summarize(result) { return result; }
    }]);

    const result = await runAgentRuntime({
      taskSessionId: session.id,
      userRequest: "继续执行",
      registry,
      contextBudgetEnabled: true,
      modelDescriptor: {
        id: "context-test-model",
        providerId: "mock",
        displayName: "Context Test",
        capabilities: { contextWindowTokens: 2_400, maxOutputTokens: 300, toolCalling: true, parallelToolCalling: false, imageInput: false, reasoningEffort: false, promptCache: false }
      },
      contextSafetyMarginTokens: 100,
      messages: [
        { id: "system-real-state", role: "system", content: "保留安全规则" },
        { id: "old-real-state", role: "user", content: "旧上下文".repeat(900) },
        { id: "current-real-state", role: "user", content: "继续执行" }
      ],
      completeModel: async () => ({
        message: { role: "assistant", toolCalls: [{ id: "approval-tool-1", name: "runCommand", arguments: { command: "pnpm test" } }] },
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 }
      }),
      metricsRecorder: async () => undefined,
      onContextBudget: ({ snapshot, summary }) => budgetEvents.push({ summary, contextWindow: snapshot.modelContextWindowTokens })
    });

    const loaded = await getTaskSession(session.id);
    assert.equal(result.status, "awaiting_approval");
    assert.equal(budgetEvents.at(-1)?.contextWindow, 2_400);
    assert.equal(budgetEvents.at(-1)?.summary?.pendingApproval?.actionId, result.pendingToolCall?.actionId);
    assert.ok(budgetEvents.at(-1)?.summary?.planStatus.some((item) => item.includes("in_progress: 修改实现")));
    assert.deepEqual(budgetEvents.at(-1)?.summary?.filesModified, ["src/changed.ts"]);
    assert.equal(loaded.contextSummary?.pendingApproval?.toolName, "runCommand");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("压缩后保留验证失败证据并继续完成修复", async () => {
  let modelStep = 0;
  let repairExecuted = false;
  let failureVisibleAfterCompression = false;
  const budgetEvents: Array<{ automaticCompression: boolean; after: number; available: number }> = [];
  const registry = createAgentToolRegistry([
    {
      name: "validateCode",
      description: "返回结构化验证失败",
      parameters: { type: "object", properties: {} },
      async execute() {
        // 工具调用本身成功返回验证诊断；避免把业务验证失败误记为工具执行异常。
        return { exitCode: 1, validationError: "TypeError TS2322 at src/value.ts:1", output: "noise\n".repeat(12_000) };
      },
      summarize(result) { return result; }
    },
    {
      name: "repairCode",
      description: "模拟根据最近失败证据完成修复",
      parameters: { type: "object", properties: {} },
      async execute() {
        repairExecuted = true;
        return { applied: true, filePath: "src/value.ts" };
      },
      summarize(result) { return result; }
    }
  ]);

  const result = await runAgentRuntime({
    userRequest: "修复类型错误并完成验证",
    registry,
    contextBudgetEnabled: true,
    contextWindowTokens: 2_800,
    maxOutputTokens: 300,
    contextSafetyMarginTokens: 100,
    messages: [
      { id: "validation-system", role: "system", content: "必须保留最近验证失败并继续修复" },
      { id: "validation-old", role: "user", content: "旧上下文".repeat(2_000) },
      { id: "validation-current", role: "user", content: "修复类型错误并完成验证" }
    ],
    completeModel: async (request) => {
      modelStep += 1;
      const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 };
      if (modelStep === 1) {
        return { message: { role: "assistant", toolCalls: [{ id: "validation-call", name: "validateCode", arguments: {} }] }, usage };
      }
      if (modelStep === 2) {
        // 压缩摘要属于系统指令，按新请求契约与普通对话历史分开检查。
        failureVisibleAfterCompression = JSON.stringify({ systemPrompt: request.systemPrompt, messages: request.messages }).includes("TypeError TS2322");
        return { message: { role: "assistant", toolCalls: [{ id: "repair-call", name: "repairCode", arguments: {} }] }, usage };
      }
      return { message: { role: "assistant", content: "修复完成" }, usage };
    },
    metricsRecorder: async () => undefined,
    onContextBudget: ({ snapshot }) => budgetEvents.push({
      automaticCompression: snapshot.automaticCompression,
      after: snapshot.estimatedInputTokensAfterCompression,
      available: snapshot.availableInputTokens
    })
  });

  assert.equal(result.status, "completed");
  assert.equal(failureVisibleAfterCompression, true);
  assert.equal(repairExecuted, true);
  assert.ok(result.contextSummary?.recentValidationFailures.some((failure) => failure.includes("TypeError TS2322")));
  assert.ok(budgetEvents.some((event) => event.automaticCompression));
  assert.ok(budgetEvents.every((event) => event.after <= event.available));
});

test("前端上下文事件以服务端 null 摘要清理旧审批状态", () => {
  const snapshot = {
    modelContextWindowTokens: 1_000,
    reservedOutputTokens: 100,
    reservedToolSchemaTokens: 50,
    safetyMarginTokens: 50,
    availableInputTokens: 800,
    estimatedInputTokensBeforeCompression: 900,
    estimatedInputTokensAfterCompression: 400,
    compressionCount: 1,
    truncatedArtifactCount: 1,
    includedFileCount: 1,
    usageRatio: 0.5,
    automaticCompression: true,
    generatedAt: Date.now(),
    estimator: "conservative" as const
  };
  const session = {
    id: "task-ui-context",
    contextBudgetSnapshot: snapshot,
    contextSummary: {
      version: 1 as const,
      coveredMessageIds: [],
      generatedAt: Date.now(),
      currentUserGoal: "继续任务",
      confirmedDecisions: [],
      unresolvedQuestions: [],
      filesRead: [],
      filesModified: [],
      commands: [],
      planStatus: [],
      recentValidationFailures: [],
      pendingApproval: { actionId: "run:test", toolName: "runCommand", arguments: { command: "pnpm test" } }
    }
  } as unknown as Parameters<typeof mergeContextBudgetSession>[0];

  const merged = mergeContextBudgetSession(session, { taskSessionId: session.id, snapshot, summary: null });
  assert.equal(merged.contextSummary, undefined);
  assert.equal(mergeContextBudgetSession(session, { taskSessionId: "another-task", snapshot, summary: null }), session);
});
