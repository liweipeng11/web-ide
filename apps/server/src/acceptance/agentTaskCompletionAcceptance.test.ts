import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completionAgentToolDefinitions } from "../agentCompletionTools.js";
import { resumeAgentRuntimeAfterApproval, runAgentRuntime, type AgentRuntimeOptions } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { AgentToolDefinition, AgentToolRuntime } from "../agentToolTypes.js";
import { writeFile as writeWorkspaceContent } from "../fileEditService.js";
import { clearTaskMetricsForTest, getTaskSessionPersistenceMetrics } from "../observability/index.js";
import { createTaskSession, getTaskSession } from "../taskSessionStore.js";
import { finalizeTaskSession } from "../taskSessionFinalizer.js";
import { setWorkspaceRoot } from "../workspaceStore.js";

const strictRollout = { mode: "strict" as const };

function tool(name: string, execute: AgentToolDefinition["execute"]): AgentToolDefinition {
  return {
    name,
    description: `阶段七验收工具：${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    cacheable: false,
    execute,
    summarize(result) {
      return result && typeof result === "object" ? result as Record<string, unknown> : { result };
    }
  };
}

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

function response(...toolCalls: ReturnType<typeof call>[]) {
  return { choices: [{ message: { role: "assistant" as const, content: null, tool_calls: toolCalls } }] };
}

function completion(id: string, summary = "验收完成") {
  return call(id, "completeTask", { summary, verified: true, validationSummary: "验收验证通过" });
}

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-ide-completion-acceptance-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  try {
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function runVerifiedEditScenario(input: { filePath: string; initialContent?: string; finalContent: string }) {
  return withWorkspace(async (workspaceRoot) => {
    const absolutePath = path.join(workspaceRoot, input.filePath);
    if (input.initialContent !== undefined) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, input.initialContent, "utf8");
    }
    let round = 0;
    const registry = createAgentToolRegistry([
      tool("replaceInFile", async (_args, runtime) => {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, input.finalContent, "utf8");
        return { changed: true, filePath: input.filePath, finalContent: input.finalContent };
      }),
      tool("runCommand", async () => ({ exitCode: 0 })),
      tool("recordValidation", async (_args, runtime) => {
        runtime.agentContext.commandsRun = [{ command: "pnpm test", status: "success", exitCode: 0, validation: true, finishedAt: Date.now() }];
        return { status: "success" };
      }),
      ...completionAgentToolDefinitions
    ]);
    const result = await runAgentRuntime({
      userRequest: `修改 ${input.filePath} 并验证`, mode: "act", registry, maxSteps: 5, contextBudgetEnabled: false,
      explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
      requestCompletion: async () => {
        round += 1;
        if (round === 1) return response(call("edit", "replaceInFile", { filePath: input.filePath }));
        if (round === 2) return response(call("validate", "recordValidation"));
        return response(completion("complete"));
      }
    });
    assert.equal(result.status, "completed");
    assert.equal(result.completionEvidence?.validationStatus, "passed");
    assert.equal(await fs.readFile(absolutePath, "utf8"), input.finalContent);
  });
}

test("阶段七场景 1：创建新文件并验证成功", async () => {
  await runVerifiedEditScenario({ filePath: "src/new.ts", finalContent: "export const created = true;\n" });
});

test("阶段七场景 2：修改已有文件并验证成功", async () => {
  await runVerifiedEditScenario({ filePath: "src/existing.ts", initialContent: "export const value = 1;\n", finalContent: "export const value = 2;\n" });
});

test("阶段七场景 3：连续提交相同内容不会产生物理写入", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const filePath = "src/stable.ts";
    await writeWorkspaceContent({ filePath, content: "export const stable = true;\n", createIfMissing: true });
    const absolutePath = path.join(workspaceRoot, filePath);
    const before = await fs.stat(absolutePath);
    const first = await writeWorkspaceContent({ filePath, content: "export const stable = true;\n" });
    const second = await writeWorkspaceContent({ filePath, content: "export const stable = true;\n" });
    const after = await fs.stat(absolutePath);
    assert.equal(first.changed, false);
    assert.equal(second.changed, false);
    assert.equal(after.mtimeMs, before.mtimeMs);
  });
});

function approvalRegistry(executions: { count: number }) {
  return createAgentToolRegistry([
    tool("applyPatch", async () => { executions.count += 1; return { changed: true, filePath: "src/a.ts" }; }),
    ...completionAgentToolDefinitions
  ]);
}

test("阶段七场景 4：Patch 应用进入等待审批且不提前执行", async () => {
  const executions = { count: 0 };
  const result = await runAgentRuntime({
    userRequest: "应用待审核 Patch", mode: "act", registry: approvalRegistry(executions), maxSteps: 2,
    contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    requestCompletion: async () => response(call("apply", "applyPatch", { patchId: "patch-1" }))
  });
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.completionEvidence?.pendingApprovalCount, 1);
  assert.equal(executions.count, 0);
});

test("阶段七场景 5：用户拒绝 Patch 后不会执行被拒绝的变更", async () => {
  const executions = { count: 0 };
  const registry = approvalRegistry(executions);
  const base: AgentRuntimeOptions = {
    userRequest: "应用待审核 Patch", mode: "act", registry, maxSteps: 2, contextBudgetEnabled: false,
    explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    requestCompletion: async () => response(call("apply", "applyPatch", { patchId: "patch-2" }))
  };
  const waiting = await runAgentRuntime(base);
  assert.ok(waiting.pendingToolCall);
  const rejected = await resumeAgentRuntimeAfterApproval({
    ...base, runId: waiting.runId, agentContext: waiting.agentContext,
    pendingToolCall: waiting.pendingToolCall!, decision: "rejected",
    requestCompletion: async () => response(completion("after-reject", "Patch 已被拒绝，任务未完成"))
  });
  // 用户拒绝后模型可以结束当前任务，但拒绝的 Patch 绝不能被执行。
  assert.equal(rejected.status, "completed");
  assert.equal(executions.count, 0);
});

test("阶段七场景 6：验证失败的编辑任务不得 success", async () => {
  let round = 0;
  const registry = createAgentToolRegistry([
    tool("replaceInFile", async () => ({ changed: true, filePath: "src/a.ts" })),
    tool("runCommand", async () => ({ exitCode: 1 })),
    tool("recordValidation", async (_args, runtime: AgentToolRuntime) => {
      runtime.agentContext.commandsRun = [{ command: "pnpm test", status: "failed", exitCode: 1, validation: true, finishedAt: Date.now() }];
      return { status: "failed" };
    }),
    ...completionAgentToolDefinitions
  ]);
  const result = await runAgentRuntime({
    userRequest: "修改文件并运行测试", mode: "act", registry, maxSteps: 5, contextBudgetEnabled: false,
    explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    requestCompletion: async () => {
      round += 1;
      if (round === 1) return response(call("edit", "replaceInFile", { filePath: "src/a.ts" }));
      if (round === 2) return response(call("failed-validation", "recordValidation"));
      return response(completion("invalid-complete"));
    }
  });
  assert.notEqual(result.status, "completed");
  assert.equal(result.agentContext.commandsRun?.at(-1)?.status, "failed");
  assert.equal(result.messages.some((message) => message.role === "tool" && String(message.content).includes("验证命令执行失败")), true);
});

test("阶段七场景 7：Provider 中途错误映射为 failed", async () => {
  await withWorkspace(async () => {
    const session = await createTaskSession("分析 Provider 错误");
    await assert.rejects(() => runAgentRuntime({
      userRequest: "分析错误", mode: "plan", registry: createAgentToolRegistry(completionAgentToolDefinitions),
      taskSessionId: session.id, contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
      completeModel: async () => { throw new Error("provider unavailable"); }
    }), /provider unavailable/);
    const finalized = await finalizeTaskSession({ taskSessionId: session.id, runtimeResult: { status: "failed" }, source: "provider_error" });
    assert.equal(finalized?.status, "failed");
  });
});

test("阶段七场景 8：客户端断开映射为 cancelled", async () => {
  await withWorkspace(async () => {
    const session = await createTaskSession("客户端断开场景");
    const error = new Error("client disconnected");
    error.name = "AbortError";
    await assert.rejects(() => runAgentRuntime({
      userRequest: "长任务", mode: "plan", registry: createAgentToolRegistry(completionAgentToolDefinitions),
      taskSessionId: session.id, contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
      completeModel: async () => { throw error; }
    }), { name: "AbortError" });
    const finalized = await finalizeTaskSession({ taskSessionId: session.id, clientClosed: true, source: "client_disconnect" });
    assert.equal(finalized?.status, "cancelled");
  });
});

test("阶段七场景 9：严格模式下未调用 completeTask 不得完成", async () => {
  const result = await runAgentRuntime({
    userRequest: "分析当前实现", mode: "plan", registry: createAgentToolRegistry(completionAgentToolDefinitions), maxSteps: 2,
    contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    requestCompletion: async () => ({ choices: [{ message: { role: "assistant", content: "分析完成" } }] })
  });
  assert.equal(result.status, "incomplete");
  assert.match(result.statusReason ?? "", /completeTask/);
});

test("阶段七场景 10：重复 completeTask 被拒绝且只完成一次", async () => {
  let round = 0;
  let completedEvents = 0;
  const result = await runAgentRuntime({
    userRequest: "分析当前实现", mode: "plan", registry: createAgentToolRegistry(completionAgentToolDefinitions), maxSteps: 3,
    contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    onAgentStep: (step) => { if (step.type === "message" && step.content === "验收完成") completedEvents += 1; },
    requestCompletion: async () => {
      round += 1;
      return round === 1
        ? response(completion("duplicate-1"), completion("duplicate-2"))
        : response(completion("single"));
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(round, 2);
  assert.equal(completedEvents, 1);
});

test("阶段七场景 11：completeTask 后同轮写文件会整轮拒绝", async () => {
  let round = 0;
  let writes = 0;
  const registry = createAgentToolRegistry([
    tool("replaceInFile", async () => { writes += 1; return { changed: true, filePath: "src/a.ts" }; }),
    ...completionAgentToolDefinitions
  ]);
  const result = await runAgentRuntime({
    userRequest: "分析并按需修改", mode: "plan", registry, maxSteps: 3, contextBudgetEnabled: false,
    explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    requestCompletion: async () => {
      round += 1;
      return round === 1
        ? response(completion("complete-with-write"), call("late-write", "replaceInFile", { filePath: "src/a.ts" }))
        : response(completion("complete-only"));
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(writes, 0);
});

test("阶段七场景 12：Windows rename 暂时 EPERM 时恢复且无临时文件残留", async (t) => {
  await withWorkspace(async () => {
    const originalRename = fs.rename.bind(fs);
    let attempts = 0;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      attempts += 1;
      if (attempts < 3) {
        const error = new Error("temporarily locked") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      return originalRename(...args);
    });
    const session = await createTaskSession("验证 Windows rename 恢复");
    assert.equal((await getTaskSession(session.id)).status, "running");
    assert.equal(attempts, 3);
    const metrics = await getTaskSessionPersistenceMetrics(session.id);
    assert.equal(metrics.taskSessionRenameRetryCount, 2);
    await clearTaskMetricsForTest({ key: session.id });
  });
});
