import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { completionAgentToolDefinitions } from "../agentCompletionTools.js";
import { resumeAgentRuntimeAfterApproval, runAgentRuntime, type AgentRuntimeOptions } from "../agentRuntime.js";
import { createAgentToolRegistry } from "../agentToolRegistry.js";
import type { AgentToolDefinition, AgentToolRuntime } from "../agentToolTypes.js";
import { config } from "../config.js";
import { writeFile as writeWorkspaceContent } from "../fileEditService.js";
import { clearTaskMetricsForTest, getTaskSessionPersistenceMetrics } from "../observability/index.js";
import { advanceTaskPlanProgress, appendTaskSessionStep, createTaskSession, decideTaskSessionApproval, getTaskSession } from "../taskSessionStore.js";
import { finalizeTaskSession } from "../taskSessionFinalizer.js";
import { initializeTaskPlan } from "../taskPlanService.js";
import type { AgentStep } from "../types.js";
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

test("阶段一验收：writeFile 与 runCommand 跨两次审批后仍可完成", async () => {
  await withWorkspace(async () => {
    const session = await createTaskSession("创建 src/evidence.ts 并验证");
    const registry = createAgentToolRegistry([
      tool("writeFile", async () => ({ changed: true, filePath: "src/evidence.ts" })),
      tool("runCommand", async (_args, runtime) => {
        runtime.agentContext.commandsRun = [{
          command: "pnpm test",
          status: "success",
          exitCode: 0,
          validation: true,
          // 验证发生在文件落盘之后，完成策略应允许结束任务。
          finishedAt: Date.now() + 10
        }];
        return { exitCode: 0, status: "success" };
      }),
      ...completionAgentToolDefinitions
    ]);
    const common: AgentRuntimeOptions = {
      taskSessionId: session.id,
      userRequest: session.userGoal,
      mode: "act",
      registry,
      maxSteps: 3,
      contextBudgetEnabled: false,
      explicitCompletionRollout: strictRollout,
      metricsRecorder: async () => undefined,
      onAgentStep: (step) => { void appendTaskSessionStep(session.id, step); }
    };

    const waitingForWrite = await runAgentRuntime({
      ...common,
      runtimeEvidence: session.runtimeEvidence,
      requestCompletion: async () => response(call("write-evidence", "writeFile", { filePath: "src/evidence.ts", content: "export const evidence = true;\n" }))
    });
    assert.equal(waitingForWrite.status, "awaiting_approval");
    await decideTaskSessionApproval(session.id, waitingForWrite.pendingToolCall!.actionId, "approved");

    const waitingForValidation = await resumeAgentRuntimeAfterApproval({
      ...common,
      pendingToolCall: waitingForWrite.pendingToolCall!,
      decision: "approved",
      requestCompletion: async () => response(call("validate-evidence", "runCommand", { command: "pnpm test" }))
    });
    assert.equal(waitingForValidation.status, "awaiting_approval");
    const afterWrite = await getTaskSession(session.id);
    assert.deepEqual(afterWrite.runtimeEvidence?.appliedFilePaths, ["src/evidence.ts"]);
    await decideTaskSessionApproval(session.id, waitingForValidation.pendingToolCall!.actionId, "approved");

    const completed = await resumeAgentRuntimeAfterApproval({
      ...common,
      pendingToolCall: waitingForValidation.pendingToolCall!,
      decision: "approved",
      requestCompletion: async () => response(completion("complete-evidence", "跨审批修改与验证完成"))
    });
    const persisted = await getTaskSession(session.id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.completionEvidence?.changedFileCount, 1);
    assert.equal(completed.completionEvidence?.validationStatus, "passed");
    assert.equal((completed.runtimeEvidence.lastValidationAt ?? 0) >= (completed.runtimeEvidence.lastMutationAt ?? 0), true);
    assert.deepEqual(persisted.runtimeEvidence, completed.runtimeEvidence);
  });
});

test("阶段二验收：遗漏瞬时进度回调时由持久化证据恢复跨审批计划", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const previousAiApiKey = config.aiApiKey;
    config.aiApiKey = "";

    try {
      const session = await createTaskSession("创建 src/phase-zero.ts 并验证");
      const plannedSession = await initializeTaskPlan(session, {
        intent: "edit",
        confidence: 1,
        normalizedGoal: session.userGoal,
        reason: "阶段零故障基线需要真实 feature 工作流"
      }, { forceApproval: false });
      assert.ok(plannedSession);
      assert.ok(plannedSession.planItems);
      const steps: AgentStep[] = [];
      const targetFile = "src/phase-zero.ts";
      const registry = createAgentToolRegistry([
        tool("writeFile", async (args) => {
          // 使用真实文件服务落盘，确保基线同时包含物理文件与 Runtime 变更证据。
          return writeWorkspaceContent({
            filePath: String(args.filePath),
            content: String(args.content),
            createIfMissing: true
          });
        }),
        tool("runCommand", async (_args, runtime) => {
          runtime.agentContext.commandsRun = [{
            command: "pnpm build",
            status: "success",
            exitCode: 0,
            validation: true,
            // 保证验证证据严格晚于本次文件变更。
            finishedAt: Date.now() + 10
          }];
          return { exitCode: 0, status: "success" };
        }),
        ...completionAgentToolDefinitions
      ]);
      const common: AgentRuntimeOptions = {
        taskSessionId: plannedSession.id,
        userRequest: plannedSession.userGoal,
        mode: "act",
        registry,
        maxSteps: 3,
        contextBudgetEnabled: false,
        explicitCompletionRollout: strictRollout,
        metricsRecorder: async () => undefined,
        // 模拟 SSE 断线或进度回调丢失，计划只能依靠已落盘 Runtime 证据恢复。
        onTaskProgress: async () => undefined,
        onAgentStep: (step) => {
          steps.push(step);
          void appendTaskSessionStep(plannedSession.id, step);
        }
      };

      assert.deepEqual(
        plannedSession.planItems.map((item) => item.workflowStepId),
        ["analyze-project", "find-patterns", "plan-files", "implement", "validate", "summarize"]
      );

      const waitingForWrite = await runAgentRuntime({
        ...common,
        runtimeEvidence: plannedSession.runtimeEvidence,
        requestCompletion: async () => response(call("phase-zero-write", "writeFile", {
          filePath: targetFile,
          content: "export const phaseZero = true;\n"
        }))
      });
      assert.equal(waitingForWrite.status, "awaiting_approval");
      await decideTaskSessionApproval(plannedSession.id, waitingForWrite.pendingToolCall!.actionId, "approved");

      const waitingForValidation = await resumeAgentRuntimeAfterApproval({
        ...common,
        pendingToolCall: waitingForWrite.pendingToolCall!,
        decision: "approved",
        requestCompletion: async () => response(call("phase-zero-validate", "runCommand", { command: "pnpm build" }))
      });
      assert.equal(waitingForValidation.status, "awaiting_approval");
      await decideTaskSessionApproval(plannedSession.id, waitingForValidation.pendingToolCall!.actionId, "approved");

      const result = await resumeAgentRuntimeAfterApproval({
        ...common,
        // 首次有效完成请求必须直接通过，不能再进入 PENDING_PLAN 恢复循环。
        maxSteps: 1,
        pendingToolCall: waitingForValidation.pendingToolCall!,
        decision: "approved",
        requestCompletion: async () => response(completion("phase-zero-complete", "文件与构建均已完成"))
      });
      const persisted = await getTaskSession(plannedSession.id);
      const rejected = steps.find((step): step is Extract<AgentStep, { type: "completion_rejected" }> => step.type === "completion_rejected");

      assert.equal(result.status, "completed");
      assert.equal(rejected, undefined);
      assert.equal(await fs.readFile(path.join(workspaceRoot, targetFile), "utf8"), "export const phaseZero = true;\n");
      assert.deepEqual(persisted.runtimeEvidence?.appliedFilePaths, [targetFile]);
      assert.equal(result.agentContext.commandsRun?.at(-1)?.status, "success");
      assert.equal(result.agentContext.commandsRun?.at(-1)?.validation, true);
      assert.equal((persisted.runtimeEvidence?.lastValidationAt ?? 0) > (persisted.runtimeEvidence?.lastMutationAt ?? 0), true);
      assert.equal(persisted.runtimeEvidence?.lastValidationStatus, "success");
      assert.deepEqual(
        (persisted.planItems ?? []).filter((item) => item.workflowStepId === "implement" || item.workflowStepId === "validate" || item.workflowStepId === "summarize")
          .map((item) => ({ workflowStepId: item.workflowStepId, status: item.status })),
        [
          { workflowStepId: "implement", status: "completed" },
          { workflowStepId: "validate", status: "completed" },
          { workflowStepId: "summarize", status: "completed" }
        ]
      );
    } finally {
      config.aiApiKey = previousAiApiKey;
    }
  });
});

test("阶段二验收：非审批运行在 completeTask 裁决前由持久化证据校准计划", async () => {
  await withWorkspace(async () => {
    const previousAiApiKey = config.aiApiKey;
    config.aiApiKey = "";

    try {
      const session = await createTaskSession("直接修改 src/direct.ts 并验证");
      const plannedSession = await initializeTaskPlan(session, {
        intent: "edit",
        confidence: 1,
        normalizedGoal: session.userGoal,
        reason: "覆盖非审批路径完成前校准"
      }, { forceApproval: false });
      assert.ok(plannedSession);

      let round = 0;
      const registry = createAgentToolRegistry([
        tool("replaceInFile", async () => ({ changed: true, filePath: "src/direct.ts" })),
        tool("runCommand", async () => ({ exitCode: 0, status: "success" })),
        tool("recordValidation", async (_args, runtime) => {
          runtime.agentContext.commandsRun = [{
            command: "pnpm test",
            status: "success",
            exitCode: 0,
            validation: true,
            finishedAt: Date.now()
          }];
          return { status: "success" };
        }),
        ...completionAgentToolDefinitions
      ]);

      const result = await runAgentRuntime({
        taskSessionId: plannedSession.id,
        userRequest: plannedSession.userGoal,
        mode: "act",
        registry,
        maxSteps: 5,
        contextBudgetEnabled: false,
        explicitCompletionRollout: strictRollout,
        metricsRecorder: async () => undefined,
        onTaskProgress: async () => undefined,
        requestCompletion: async () => {
          round += 1;
          if (round === 1) return response(call("direct-edit", "replaceInFile", { filePath: "src/direct.ts" }));
          if (round === 2) return response(call("direct-validation", "recordValidation"));
          return response(completion("direct-complete", "直接修改与验证均已完成"));
        }
      });
      const persisted = await getTaskSession(plannedSession.id);

      assert.equal(result.status, "completed");
      assert.deepEqual(
        (persisted.planItems ?? [])
          .filter((item) => ["implement", "validate", "summarize"].includes(item.workflowStepId ?? ""))
          .map((item) => item.status),
        ["completed", "completed", "completed"]
      );
    } finally {
      config.aiApiKey = previousAiApiKey;
    }
  });
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
    const progressPhases: string[] = [];
    const error = new Error("client disconnected");
    error.name = "AbortError";
    await assert.rejects(() => runAgentRuntime({
      userRequest: "长任务", mode: "plan", registry: createAgentToolRegistry(completionAgentToolDefinitions),
      taskSessionId: session.id, contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
      onTaskProgress: async (phase) => { progressPhases.push(phase); },
      completeModel: async () => { throw error; }
    }), { name: "AbortError" });
    const finalized = await finalizeTaskSession({ taskSessionId: session.id, clientClosed: true, source: "client_disconnect" });
    assert.equal(finalized?.status, "cancelled");
    assert.deepEqual(progressPhases, ["task_cancelled"]);
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

test("阶段六验收：只读分析任务无需文件变更即可完成", async () => {
  const steps: Array<{ type: string }> = [];
  const result = await runAgentRuntime({
    userRequest: "分析当前完成策略", mode: "plan", registry: createAgentToolRegistry(completionAgentToolDefinitions), maxSteps: 2,
    contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    onAgentStep: (step) => steps.push(step),
    requestCompletion: async () => response(completion("analysis-complete", "只读分析完成"))
  });
  assert.equal(result.status, "completed");
  assert.equal(result.completionEvidence?.changedFileCount, 0);
  assert.equal(steps.some((step) => step.type === "completion_rejected"), false);
});

test("阶段六验收：修改后未验证与验证后再次修改均不得完成", async () => {
  for (const staleValidation of [false, true]) {
    let round = 0;
    const rejectionCodes: string[] = [];
    const registry = createAgentToolRegistry([
      tool("replaceInFile", async () => ({ changed: true, filePath: "src/stale.ts" })),
      tool("runCommand", async () => ({ exitCode: 0 })),
      tool("recordValidation", async (_args, runtime) => {
        runtime.agentContext.commandsRun = [{ command: "pnpm test", status: "success", exitCode: 0, validation: true, finishedAt: Date.now() - 1_000 }];
        return { exitCode: 0 };
      }),
      ...completionAgentToolDefinitions
    ]);
    const result = await runAgentRuntime({
      userRequest: "修改并验证 src/stale.ts", mode: "act", registry, maxSteps: staleValidation ? 6 : 4,
      contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
      onAgentStep: (step) => { if (step.type === "completion_rejected") rejectionCodes.push(step.rejectionCode); },
      requestCompletion: async () => {
        round += 1;
        if (round === 1) return response(call("edit-1", "replaceInFile", { filePath: "src/stale.ts" }));
        if (staleValidation && round === 2) return response(call("validate", "recordValidation"));
        if (staleValidation && round === 3) return response(call("edit-2", "replaceInFile", { filePath: "src/stale.ts" }));
        return response(completion(`reject-${round}`));
      }
    });
    assert.equal(result.status, "incomplete");
    assert.equal(result.completionEvidence?.validationStatus, staleValidation ? "passed" : "not_run");
    assert.equal(rejectionCodes[0], staleValidation ? "VALIDATION_STALE" : "VALIDATION_NOT_RUN");
  }
});

test("阶段六验收：无文件变化时返回结构化拒绝并在第三次相同请求后熔断", async () => {
  const steps: Array<{ type: string; rejectionCode?: string }> = [];
  let providerCallCount = 0;
  const result = await runAgentRuntime({
    userRequest: "修改 src/no-change.ts", mode: "act",
    registry: createAgentToolRegistry([tool("replaceInFile", async () => ({ changed: false, filePath: "src/no-change.ts" })), ...completionAgentToolDefinitions]),
    maxSteps: 5, contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    onAgentStep: (step) => steps.push(step),
    requestCompletion: async () => { providerCallCount += 1; return response(completion(`unchanged-${providerCallCount}`)); }
  });
  assert.equal(result.status, "incomplete");
  assert.equal(providerCallCount, 3);
  assert.equal(steps[0]?.type, "completion_rejected");
  assert.equal(steps[0]?.rejectionCode, "NO_MUTATION_EVIDENCE");
  assert.equal(steps.at(-1)?.rejectionCode, "UNCHANGED_COMPLETION_EVIDENCE");
});

test("阶段六验收：结构化拒绝开关关闭后回退为旧 Tool failed 步骤", async () => {
  const steps: Array<{ type: string }> = [];
  await runAgentRuntime({
    userRequest: "修改 src/legacy.ts", mode: "act",
    registry: createAgentToolRegistry([tool("replaceInFile", async () => ({ changed: false })), ...completionAgentToolDefinitions]),
    maxSteps: 1, contextBudgetEnabled: false, explicitCompletionRollout: strictRollout, metricsRecorder: async () => undefined,
    completionPolicyFlags: { taskRuntimeEvidencePersistence: true, completionRejectionConvergence: true, structuredCompletionRejection: false },
    completionPolicyRollout: { mode: "all" }, onAgentStep: (step) => steps.push(step),
    requestCompletion: async () => response(completion("legacy-rejection"))
  });
  assert.equal(steps.some((step) => step.type === "error"), true);
  assert.equal(steps.some((step) => step.type === "completion_rejected"), false);
});
