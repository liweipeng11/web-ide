import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { appendAgentMessage, clearPendingAgentToolCall, getPendingAgentToolCall, listAgentMessages, setPendingAgentToolCall } from "./agentMessageStore.js";
import { createCheckpoint } from "./checkpointStore.js";
import { projectRuntimeDirectory } from "./statePaths.js";
import { addTaskPlanItem, addTaskSessionCheckpoint, addTaskSessionFilesChanged, advanceTaskPlanProgress, appendTaskSessionAgentMessage, appendTaskSessionFileEditEvent, appendTaskSessionPatchEvent, appendTaskSessionRecoveryDecision, appendTaskSessionStep, appendTaskSessionToolFailureDiagnostic, approveTaskSessionPlan, completeTaskSessionDeliveryUnit, createTaskSession, decideTaskSessionApproval, deleteTaskPlanItem, deleteTaskSession, flushPendingTaskSessionWrites, getTaskSession, interruptTaskSessionForReplan, listTaskSessions, reconcileTaskPlanFromRuntimeEvidence, recordTaskSessionContextBudget, recordTaskSessionPatchDiagnostics, setActiveTaskSessionDeliveryUnit, setTaskPlanItems, setTaskSessionContinuation, setTaskSessionDeliveryUnits, setTaskSessionModificationPlan, setTaskSessionPendingToolCall, setTaskSessionRuntimeEvidence, setTaskSessionRuntimePlanning, updateTaskPlanItem, updateTaskSessionChatId, updateTaskSessionStatus } from "./taskSessionStore.js";
import { setWorkspaceRoot } from "./workspaceStore.js";
import { buildDeliveryUnitsFromTaskPlan, createFallbackTaskPlan, initializeTaskPlan, rewriteTaskPlanWithInstruction, shouldInitializeTaskPlan } from "./taskPlanService.js";
import { clearTaskMetricsForTest, getTaskSessionPersistenceMetrics, RunMetricsTracker } from "./observability/index.js";
import { finalizeTaskSession } from "./taskSessionFinalizer.js";
import type { TaskSession } from "./types.js";

async function createIsolatedTaskSession(userGoal = "实现任务计划器") {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-plan-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  return {
    workspaceRoot,
    session: await createTaskSession(userGoal)
  };
}

test("新 Runtime DAG 与 Planner 结果可在任务会话中持久化恢复", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("迁移认证系统");
  const plan = {
    version: 1,
    goal: session.userGoal,
    assumptions: [],
    completionCriteria: ["迁移完成"],
    tasks: [{
      id: "T1",
      type: "explore" as const,
      goal: "确认认证现状",
      dependencies: [],
      requiredCapabilities: ["exploration"],
      readScope: ["**"],
      writeScope: [],
      acceptanceCriteria: ["输出认证事实"],
      status: "pending" as const
    }]
  };
  try {
    await setTaskSessionRuntimePlanning(session.id, { status: "ready", plan });
    const restored = await getTaskSession(session.id);
    assert.equal(restored.plannerOutcome?.status, "ready");
    assert.equal(restored.runtimePlan?.tasks[0]?.id, "T1");

    await setTaskSessionRuntimePlanning(session.id, { status: "missing_context", required: ["需要认证模块结构"] });
    const waiting = await getTaskSession(session.id);
    assert.equal(waiting.status, "awaiting_user");
    assert.deepEqual(waiting.plannerOutcome?.required, ["需要认证模块结构"]);
    assert.equal(waiting.runtimePlan?.version, 1);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("生产计划初始化通过 Main 规划入口保存 DAG", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("重构整个认证系统");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";
  try {
    const planned = await initializeTaskPlan(session, {
      intent: "edit",
      confidence: 1,
      normalizedGoal: session.userGoal,
      reason: "跨模块迁移"
    }, {
      runtimePlanning: true,
      runtimePlanner: {
        async plan() {
          return {
            decision: { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: ["planning"] } as const,
            planning: {
              status: "ready" as const,
              plan: {
                version: 1,
                goal: session.userGoal,
                assumptions: [],
                completionCriteria: ["迁移完成"],
                tasks: [{
                  id: "T1", type: "implement" as const, goal: "迁移认证", dependencies: [], requiredCapabilities: ["editing"],
                  readScope: ["**"], writeScope: ["**"], acceptanceCriteria: ["完成兼容迁移"], status: "pending" as const
                }]
              }
            }
          };
        }
      }
    });

    assert.equal(planned?.runtimePlan?.tasks[0]?.goal, "迁移认证");
    assert.equal(planned?.plannerOutcome?.status, "ready");
    assert.ok(planned?.planItems?.length);
  } finally {
    config.aiApiKey = previousAiApiKey;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("生产计划缺少上下文时暂停任务且不生成伪计划", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("重构未知认证系统");
  try {
    const planned = await initializeTaskPlan(session, {
      intent: "edit",
      confidence: 1,
      normalizedGoal: session.userGoal,
      reason: "缺少仓库事实"
    }, {
      runtimePlanning: true,
      runtimePlanner: {
        async plan() {
          return {
            decision: { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: ["planning"] } as const,
            planning: { status: "missing_context" as const, required: ["需要认证模块结构"] }
          };
        }
      }
    });

    assert.equal(planned?.status, "awaiting_user");
    assert.equal(planned?.plannerOutcome?.status, "missing_context");
    assert.deepEqual(planned?.planItems, []);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("阶段 1 状态可持久化、脱敏并与计划双向同步", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("持久化交付单元");
  try {
    const planned = await setTaskPlanItems(session.id, [{ title: "实现服务" }]);
    const planItemId = planned!.planItems![0]!.id;
    const configured = await setTaskSessionDeliveryUnits(session.id, [{
      id: "unit-service", title: "实现服务", sourcePlanItemIds: [planItemId], status: "pending",
      completionCriteria: ["生成可审核补丁"], candidateFiles: ["src/service.ts"], filesRead: [], plannedFiles: ["src/service.ts"], dependencyUnitIds: [], checkpointIds: [], verificationCommands: ["pnpm test"]
    }]);
    assert.equal(configured?.deliveryUnits?.[0]?.version, 1);

    const active = await setActiveTaskSessionDeliveryUnit(session.id, "unit-service");
    assert.equal(active?.planItems?.[0]?.status, "in_progress");
    await appendTaskSessionToolFailureDiagnostic(session.id, { toolName: "runCommand", parameterSummary: "token=secret-value", errorSignature: "raw-token=secret-value", errorCategory: "transient", retryable: true, deliveryUnitId: "unit-service" });
    await appendTaskSessionRecoveryDecision(session.id, { triggerSignal: "no_progress", candidateActions: ["retry", "replan"], finalAction: "replan", reason: "需要更多上下文", evidence: ["无新增文件"], deliveryUnitId: "unit-service" });
    await setTaskSessionContinuation(session.id, { nextStep: "replan", requiredUserInputs: [], autoContinueConditions: ["补齐文件范围"], message: "建议重新规划", deliveryUnitId: "unit-service" });

    const completed = await completeTaskSessionDeliveryUnit(session.id, "unit-service", "pnpm test 通过");
    assert.equal(completed?.deliveryUnits?.[0]?.status, "validated");
    assert.equal(completed?.planItems?.[0]?.status, "completed");
    const restored = await getTaskSession(session.id);
    assert.equal(restored.activeDeliveryUnitId, undefined);
    assert.equal(restored.toolFailureDiagnostics?.[0]?.parameterSummary.includes("secret-value"), false);
    assert.equal(restored.toolFailureDiagnostics?.[0]?.errorSignature?.includes("secret-value"), false);
    assert.equal(restored.recoveryHistory?.[0]?.finalAction, "replan");
    assert.equal(restored.continuation?.nextStep, "replan");
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test("文件级修改计划已落库时进入实现步骤", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("移动页面并更新路由");
  try {
    await fs.writeFile(path.join(workspaceRoot, "router.ts"), "export {};\n", "utf8");
    await setTaskPlanItems(session.id, [
      { workflowStepId: "analyze-project", title: "分析项目", status: "in_progress" },
      { workflowStepId: "find-patterns", title: "查找模式" },
      { workflowStepId: "plan-files", title: "确认文件计划" },
      { workflowStepId: "implement", title: "实现变更" },
      { workflowStepId: "validate", title: "验证" }
    ]);

    const updated = await setTaskSessionModificationPlan(session.id, {
      id: "plan-relocate", taskDescription: "更新路由", createdAt: Date.now(),
      files: [{ filePath: "router.ts", changeKind: "modify", reason: "更新导入路径" }]
    });

    assert.deepEqual(updated?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "in_progress", "pending"]);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("旧会话缺失阶段 1 字段时保持可读", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("旧会话兼容");
  try {
    const filePath = path.join(projectRuntimeDirectory("task-sessions"), `${session.id}.json`);
    const legacy = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    delete legacy.deliveryUnits; delete legacy.activeDeliveryUnitId; delete legacy.toolFailureDiagnostics; delete legacy.recoveryHistory; delete legacy.continuation; delete legacy.explorerArtifacts; delete legacy.testerArtifacts;
    await fs.writeFile(filePath, JSON.stringify(legacy), "utf8");
    const restored = await getTaskSession(session.id);
    assert.deepEqual(restored.deliveryUnits, []);
    assert.deepEqual(restored.toolFailureDiagnostics, []);
    assert.deepEqual(restored.recoveryHistory, []);
    assert.deepEqual(restored.explorerArtifacts, []);
    assert.deepEqual(restored.testerArtifacts, []);
    assert.equal(restored.continuation, undefined);
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test("任务运行证据持久化后可恢复且新任务不会继承旧证据", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("跨审批保存完成证据");
  try {
    assert.ok(session.runtimeEvidence?.taskRunId);
    await setTaskSessionRuntimeEvidence(session.id, {
      taskRunId: session.runtimeEvidence!.taskRunId,
      appliedFilePaths: ["src/a.ts", "src/a.ts"],
      generatedPatchIds: ["patch-1"],
      lastMutationAt: 100,
      lastValidationAt: 200
    });

    const restored = await getTaskSession(session.id);
    assert.deepEqual(restored.runtimeEvidence, {
      taskRunId: session.runtimeEvidence!.taskRunId,
      appliedFilePaths: ["src/a.ts"],
      generatedPatchIds: ["patch-1"],
      lastMutationAt: 100,
      lastValidationAt: 200
    });

    const next = await createTaskSession("全新任务");
    assert.notEqual(next.runtimeEvidence?.taskRunId, restored.runtimeEvidence?.taskRunId);
    assert.deepEqual(next.runtimeEvidence?.appliedFilePaths, []);
    assert.deepEqual(next.runtimeEvidence?.generatedPatchIds, []);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("adds, updates, and deletes task plan items", async () => {
  const { session } = await createIsolatedTaskSession();

  const added = await addTaskPlanItem(session.id, { title: "梳理任务目标" });
  assert.equal(added?.planItems?.length, 1);
  assert.equal(added?.planItems?.[0]?.title, "梳理任务目标");
  assert.equal(added?.planItems?.[0]?.status, "pending");

  const planItemId = added?.planItems?.[0]?.id || "";
  const updated = await updateTaskPlanItem(session.id, planItemId, {
    title: "拆分任务步骤",
    status: "in_progress",
    note: "先完成手动计划维护闭环"
  });

  assert.equal(updated?.planItems?.[0]?.title, "拆分任务步骤");
  assert.equal(updated?.planItems?.[0]?.status, "in_progress");
  assert.equal(updated?.planItems?.[0]?.note, "先完成手动计划维护闭环");

  const persisted = await getTaskSession(session.id);
  assert.equal(persisted.planItems?.[0]?.status, "in_progress");

  const removed = await deleteTaskPlanItem(session.id, planItemId);
  assert.deepEqual(removed?.planItems, []);
});

test("任务会话持久化实际 Provider 和模型选择", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-model-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  try {
    const modelSelection = { providerId: "openai-compatible", modelId: "task-specific-model" };
    const session = await createTaskSession("使用指定模型", { agentMode: "plan", modelSelection });
    const loaded = await getTaskSession(session.id);
    assert.deepEqual(loaded.modelSelection, modelSelection);
    assert.equal(loaded.agentMode, "plan");
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test("任务完成时把模型 Usage 和费用写入会话", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("记录模型用量");
  try {
    const tracker = new RunMetricsTracker({ runId: "task-session-usage", taskSessionId: session.id, provider: "mock", model: "priced-model", mode: "chat" }, async () => {});
    tracker.setPrice({ currency: "USD", inputPerMillionTokens: 2, outputPerMillionTokens: 8 });
    tracker.addUsage({ inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedInputTokens: 0 });
    await tracker.finish({ status: "completed" });
    const completed = await finalizeTaskSession({ taskSessionId: session.id, runtimeResult: { status: "completed" }, source: "agent_runtime" });
    assert.deepEqual(completed?.modelUsage, { inputTokens: 10, outputTokens: 2, reasoningTokens: 0, cachedInputTokens: 0 });
    assert.equal(completed?.estimatedCostUsd, 0.000036);
  } finally { await fs.rm(workspaceRoot, { recursive: true, force: true }); }
});

test("任务会话持久化 incomplete 与 blocked 终态", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("验证阶段 4 状态持久化");
  try {
    const incomplete = await finalizeTaskSession({ taskSessionId: session.id, runtimeResult: { status: "incomplete" }, source: "agent_runtime" });
    assert.equal(incomplete?.status, "incomplete");
    assert.equal((await getTaskSession(session.id)).status, "incomplete");

    const blockedSession = await createTaskSession("等待用户选择");
    const blocked = await finalizeTaskSession({ taskSessionId: blockedSession.id, runtimeResult: { status: "blocked" }, source: "agent_runtime" });
    assert.equal(blocked?.status, "blocked");
    assert.equal((await getTaskSession(blockedSession.id)).status, "blocked");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("任务会话以 UTF-8 原子 JSON 保存 Runtime 六态和完成证据", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("修复中文路由与状态展示");
  try {
    await finalizeTaskSession({
      taskSessionId: session.id,
      source: "agent_runtime",
      runtimeResult: {
        status: "step_limit_reached",
        statusReason: "达到步骤上限，仍有中文计划待处理",
        completionEvidence: {
        workflowType: "feature",
        mutationExpected: true,
        generatedPatchCount: 0,
        changedFileCount: 0,
        pendingPlanCount: 4,
        blockedPlanCount: 0,
        validationStatus: "not_run",
        pendingApprovalCount: 0,
        activeCommandCount: 0,
        failedToolCallCount: 0
        }
      }
    });

    const sessionPath = path.join(projectRuntimeDirectory("task-sessions"), `${session.id}.json`);
    const raw = await fs.readFile(sessionPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const loaded = await getTaskSession(session.id);

    assert.match(raw, /中文路由与状态展示/);
    assert.equal(parsed.runtimeStatus, "step_limit_reached");
    assert.deepEqual(
      {
        requestedStatus: (parsed.runtimeOutcome as Record<string, unknown>).requestedStatus,
        effectiveStatus: (parsed.runtimeOutcome as Record<string, unknown>).effectiveStatus
      },
      { requestedStatus: "step_limit_reached", effectiveStatus: "step_limit_reached" }
    );
    assert.equal(loaded.runtimeStatus, "step_limit_reached");
    assert.equal(loaded.completionEvidence?.pendingPlanCount, 4);
    assert.deepEqual((await fs.readdir(path.dirname(sessionPath))).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("任务会话损坏后从有效备份恢复审批和完成证据且保留原文件", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("创建用户页面");
  const sessionPath = path.join(projectRuntimeDirectory("task-sessions"), `${session.id}.json`);
  try {
    await setTaskSessionRuntimeEvidence(session.id, {
      taskRunId: session.runtimeEvidence!.taskRunId,
      appliedFilePaths: ["src/UserPage.tsx"],
      generatedPatchIds: ["patch-user-page"],
      lastMutationAt: 100,
      lastValidationAt: 200
    });
    await setTaskSessionPendingToolCall(session.id, {
      actionId: "approval-build",
      toolCallId: "tool-build",
      toolName: "runCommand",
      arguments: { command: "pnpm build" },
      riskLevel: "medium"
    });

    // 第二次写入前的有效快照已进入 .bak；模拟进程崩溃留下半截正式文件。
    await fs.writeFile(sessionPath, "{\"userGoal\":\"乱码", "utf8");
    const restored = await getTaskSession(session.id);
    assert.equal(restored.userGoal, "创建用户页面");
    assert.deepEqual(restored.runtimeEvidence?.appliedFilePaths, ["src/UserPage.tsx"]);
    assert.equal(restored.runtimeEvidence?.lastValidationAt, 200);
    assert.equal((await fs.readdir(path.dirname(sessionPath))).some((name) => name.startsWith(`${session.id}.json.corrupt-`)), true);
    assert.equal(await fs.readFile(sessionPath, "utf8"), "{\"userGoal\":\"乱码");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("任务会话原子替换遇到短暂文件占用时会重试", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-rename-retry-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const originalRename = fs.rename.bind(fs);
  let renameAttempts = 0;

  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    renameAttempts += 1;
    if (renameAttempts < 3) {
      const error = new Error("target file is temporarily locked") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    }
    return originalRename(...args);
  });

  try {
    const session = await createTaskSession("验证 Windows 文件占用重试");
    assert.equal((await getTaskSession(session.id)).userGoal, "验证 Windows 文件占用重试");
    assert.equal(renameAttempts, 3);
    const metrics = await getTaskSessionPersistenceMetrics(session.id);
    assert.equal(metrics.taskSessionRenameRetryCount, 2);
    assert.equal(metrics.taskSessionPhysicalWriteCount, 1);
    const directory = projectRuntimeDirectory("task-sessions");
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
    await clearTaskMetricsForTest({ key: session.id });
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("任务会话原子替换不会重试非文件占用错误", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-rename-failure-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  let renameAttempts = 0;

  t.mock.method(fs, "rename", async () => {
    renameAttempts += 1;
    const error = new Error("invalid rename target") as NodeJS.ErrnoException;
    error.code = "EINVAL";
    throw error;
  });

  try {
    await assert.rejects(() => createTaskSession("验证非占用错误直接失败"), /invalid rename target/);
    assert.equal(renameAttempts, 1);
    const directory = projectRuntimeDirectory("task-sessions");
    assert.deepEqual((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("同一任务并发提交 100 次更新时按顺序合并为一次物理写入", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("验证任务状态合并写入");
  await clearTaskMetricsForTest({ key: session.id });
  try {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) => addTaskSessionFilesChanged(session.id, [`src/file-${index}.ts`]))
    );

    const loaded = await getTaskSession(session.id);
    const metrics = await getTaskSessionPersistenceMetrics(session.id);
    assert.equal(loaded.filesChanged.length, 100);
    assert.deepEqual(loaded.filesChanged, Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`));
    assert.equal(metrics.taskSessionUpdateCount, 100);
    assert.equal(metrics.taskSessionPhysicalWriteCount, 1);
    assert.equal(metrics.taskSessionWriteCoalescedCount, 99);
  } finally {
    await clearTaskMetricsForTest({ key: session.id });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("不同任务的合并批次可以并行物理写入", async (t) => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-parallel-write-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const first = await createTaskSession("并行任务一");
  const second = await createTaskSession("并行任务二");
  const originalWriteFile = fs.writeFile.bind(fs);
  let activeWrites = 0;
  let maximumActiveWrites = 0;

  t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
    activeWrites += 1;
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return await originalWriteFile(...args);
    } finally {
      activeWrites -= 1;
    }
  });

  try {
    await Promise.all([
      addTaskSessionFilesChanged(first.id, ["src/first.ts"]),
      addTaskSessionFilesChanged(second.id, ["src/second.ts"])
    ]);
    assert.ok(maximumActiveWrites >= 2);
    assert.deepEqual((await getTaskSession(first.id)).filesChanged, ["src/first.ts"]);
    assert.deepEqual((await getTaskSession(second.id)).filesChanged, ["src/second.ts"]);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("相同序列化内容跳过任务会话物理写入", async (t) => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("验证任务状态内容去重");
  try {
    t.mock.method(Date, "now", () => 1_234_567_890);
    await updateTaskSessionChatId(session.id, "chat-dedupe");
    await clearTaskMetricsForTest({ key: session.id });

    await updateTaskSessionChatId(session.id, "chat-dedupe");
    const metrics = await getTaskSessionPersistenceMetrics(session.id);
    assert.equal(metrics.taskSessionUpdateCount, 1);
    assert.equal(metrics.taskSessionPhysicalWriteCount, 0);
    assert.equal(metrics.taskSessionWriteSkippedCount, 1);
  } finally {
    await clearTaskMetricsForTest({ key: session.id });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("终态立即刷新时会同时写入此前排队的完整快照", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("验证终态立即刷新");
  try {
    const pendingUpdate = addTaskSessionFilesChanged(session.id, ["src/final.ts"]);
    const finalization = finalizeTaskSession({
      taskSessionId: session.id,
      runtimeResult: { status: "completed" },
      source: "agent_runtime"
    });

    await Promise.all([pendingUpdate, finalization]);
    const raw = JSON.parse(await fs.readFile(path.join(projectRuntimeDirectory("task-sessions"), `${session.id}.json`), "utf8")) as TaskSession;
    assert.equal(raw.status, "success");
    assert.deepEqual(raw.filesChanged, ["src/final.ts"]);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("显式 flush 会在关闭前写出合并窗口中的更新", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("验证退出前刷新");
  try {
    const pendingUpdate = addTaskSessionFilesChanged(session.id, ["src/before-exit.ts"]);
    await flushPendingTaskSessionWrites();
    await pendingUpdate;
    assert.deepEqual((await getTaskSession(session.id)).filesChanged, ["src/before-exit.ts"]);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("rejects empty task plan item titles", async () => {
  const { session } = await createIsolatedTaskSession();

  await assert.rejects(() => addTaskPlanItem(session.id, { title: "   " }), /计划标题不能为空/);

  const added = await addTaskPlanItem(session.id, { title: "准备验证" });
  const planItemId = added?.planItems?.[0]?.id || "";

  await assert.rejects(() => updateTaskPlanItem(session.id, planItemId, { title: "" }), /计划标题不能为空/);
});

test("normalizes legacy task sessions without plan items", async () => {
  const { session } = await createIsolatedTaskSession("读取旧任务记录");
  const sessionPath = path.join(projectRuntimeDirectory("task-sessions"), `${session.id}.json`);
  const persisted = JSON.parse(await fs.readFile(sessionPath, "utf8")) as Record<string, unknown>;

  // 旧版本任务记录没有 planItems 字段，读取时需要补成空数组。
  delete persisted.planItems;
  delete persisted.agentMessages;
  delete persisted.pendingToolCall;
  delete persisted.patchDiagnostics;
  delete persisted.patchEvents;
  delete persisted.fileEditEvents;
  await fs.writeFile(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  const loaded = await getTaskSession(session.id);
  assert.deepEqual(loaded.planItems, []);
  assert.deepEqual(loaded.agentMessages, []);
  assert.equal(loaded.pendingToolCall, null);
  assert.deepEqual(loaded.patchDiagnostics, []);
  assert.deepEqual(loaded.patchEvents, []);
  assert.deepEqual(loaded.fileEditEvents, []);
});

test("persists patch generation diagnostics in task sessions", async () => {
  const { session } = await createIsolatedTaskSession("记录 patch 过滤原因");

  await recordTaskSessionPatchDiagnostics(session.id, {
    patchId: "patch-diagnostics-1",
    modelSummary: "模型候选包含无效路径",
    rawPatchCount: 2,
    normalizedFilePaths: ["src/app.ts"],
    preDedupeCount: 1,
    postDedupeCount: 1,
    finalPatchCount: 1,
    filteredCount: 1,
    noEffectCount: 0,
    generatedAt: 10,
    records: [
      {
        reason: "invalid_path",
        stage: "path_validation",
        attempt: 0,
        filePath: "../outside.ts",
        detail: "路径不在工作区内"
      }
    ]
  });

  const loaded = await getTaskSession(session.id);

  assert.equal(loaded.patchDiagnostics?.length, 1);
  assert.equal(loaded.patchDiagnostics?.[0]?.patchId, "patch-diagnostics-1");
  assert.equal(loaded.patchDiagnostics?.[0]?.records[0]?.reason, "invalid_path");
});

test("persists patch lifecycle events in task sessions", async () => {
  const { session } = await createIsolatedTaskSession("记录 patch 生命周期");

  await appendTaskSessionPatchEvent(session.id, {
    id: "event-applied",
    type: "patch_file_applied",
    patchId: "patch-life-1",
    filePath: "src/app.ts",
    filePaths: ["src/app.ts"],
    message: "已应用 src/app.ts",
    detail: {
      checkpointId: "checkpoint-1"
    },
    createdAt: 20
  });
  await appendTaskSessionPatchEvent(session.id, {
    id: "event-created",
    type: "patch_created",
    patchId: "patch-life-1",
    filePaths: ["src/app.ts"],
    message: "已生成 1 个文件的修改。",
    createdAt: 10
  });

  const loaded = await getTaskSession(session.id);

  assert.deepEqual(
    loaded.patchEvents?.map((event) => [event.id, event.type, event.patchId, event.filePath || null]),
    [
      ["event-created", "patch_created", "patch-life-1", null],
      ["event-applied", "patch_file_applied", "patch-life-1", "src/app.ts"]
    ]
  );
  assert.equal(loaded.patchEvents?.[1]?.detail?.checkpointId, "checkpoint-1");
});

test("persists file edit lifecycle events in task sessions", async () => {
  const { session } = await createIsolatedTaskSession("记录工具式文件编辑生命周期");

  await appendTaskSessionFileEditEvent(session.id, {
    id: "file-edit-applied",
    type: "file_edit_applied",
    toolName: "replaceInFile",
    filePath: "src/app.ts",
    checkpointId: "checkpoint-file-edit-1",
    detail: {
      changed: true,
      replacements: 1,
      oldContentPreview: "before",
      finalContentPreview: "after"
    },
    createdAt: 20
  });
  await appendTaskSessionFileEditEvent(session.id, {
    id: "file-edit-started",
    type: "file_edit_started",
    toolName: "replaceInFile",
    filePath: "src/app.ts",
    createdAt: 10
  });

  const loaded = await getTaskSession(session.id);

  assert.deepEqual(
    loaded.fileEditEvents?.map((event) => [event.id, event.type, event.toolName, event.filePath]),
    [
      ["file-edit-started", "file_edit_started", "replaceInFile", "src/app.ts"],
      ["file-edit-applied", "file_edit_applied", "replaceInFile", "src/app.ts"]
    ]
  );
  assert.equal(loaded.fileEditEvents?.[1]?.checkpointId, "checkpoint-file-edit-1");
  assert.equal(loaded.fileEditEvents?.[1]?.detail?.replacements, 1);
  assert.equal(loaded.fileEditEvents?.[1]?.detail?.oldContentPreview, "before");
  assert.equal(loaded.fileEditEvents?.[1]?.detail?.finalContentPreview, "after");
});

test("persists failed file edit lifecycle events in task sessions", async () => {
  const { session } = await createIsolatedTaskSession("记录工具式文件编辑失败");

  await appendTaskSessionFileEditEvent(session.id, {
    type: "file_edit_failed",
    toolName: "writeFile",
    filePath: "src/missing.ts",
    detail: {
      message: "write failed"
    }
  });

  const loaded = await getTaskSession(session.id);

  assert.equal(loaded.fileEditEvents?.length, 1);
  assert.equal(loaded.fileEditEvents?.[0]?.type, "file_edit_failed");
  assert.equal(loaded.fileEditEvents?.[0]?.detail?.message, "write failed");
});

test("builds task history diff view from checkpoint files", async () => {
  const { session, workspaceRoot } = await createIsolatedTaskSession("使用 checkpoint 还原历史 diff");
  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "src", "applied.ts"), "before\n", "utf8");

  await recordTaskSessionPatchDiagnostics(session.id, {
    patchId: "patch-history-1",
    modelSummary: "生成两个候选文件",
    rawPatchCount: 2,
    normalizedFilePaths: ["src/applied.ts", "src/rejected.ts"],
    preDedupeCount: 2,
    postDedupeCount: 2,
    finalPatchCount: 2,
    filteredCount: 0,
    noEffectCount: 0,
    generatedAt: 20,
    records: []
  });

  const checkpoint = await createCheckpoint(
    "patch-history-1",
    [
      {
        filePath: "src/applied.ts",
        oldContent: "before\n",
        newContent: "after\n",
        summary: "更新已应用文件"
      }
    ],
    {
      source: {
        taskSessionId: session.id,
        patchId: "patch-history-1",
        reason: "apply_patch"
      }
    }
  );
  await addTaskSessionCheckpoint(session.id, checkpoint.id);
  await addTaskSessionFilesChanged(session.id, ["src/applied.ts"]);

  const loaded = await getTaskSession(session.id);

  assert.equal(loaded.diffView?.source, "checkpoint");
  assert.deepEqual(loaded.diffView?.generatedFiles, ["src/applied.ts", "src/rejected.ts"]);
  assert.deepEqual(loaded.diffView?.appliedFiles, ["src/applied.ts"]);
  assert.deepEqual(loaded.diffView?.rejectedFiles, ["src/rejected.ts"]);
  assert.deepEqual(loaded.diffView?.checkpointDiffFiles[0], {
    checkpointId: checkpoint.id,
    patchId: "patch-history-1",
    files: ["src/applied.ts"]
  });
});

test("persists agent messages in task sessions", async () => {
  const { session } = await createIsolatedTaskSession("存储 Agent 消息");

  await appendTaskSessionAgentMessage(session.id, {
    id: "assistant-message",
    role: "assistant",
    content: "I will inspect the project.",
    createdAt: 20
  });
  await appendTaskSessionAgentMessage(session.id, {
    id: "user-message",
    role: "user",
    content: "Please continue.",
    createdAt: 10
  });

  const loaded = await getTaskSession(session.id);

  assert.deepEqual(
    loaded.agentMessages?.map((message) => [message.id, message.role, message.content]),
    [
      ["user-message", "user", "Please continue."],
      ["assistant-message", "assistant", "I will inspect the project."]
    ]
  );
});

test("persists context budget snapshot and structured summary without replacing raw messages", async () => {
  const { session } = await createIsolatedTaskSession("上下文预算持久化");
  await appendTaskSessionAgentMessage(session.id, { id: "raw-message-1", role: "user", content: "保留原始目标", createdAt: Date.now() });
  await recordTaskSessionContextBudget(session.id, {
    modelContextWindowTokens: 1_000, reservedOutputTokens: 100, reservedToolSchemaTokens: 50, safetyMarginTokens: 50,
    availableInputTokens: 800, estimatedInputTokensBeforeCompression: 900, estimatedInputTokensAfterCompression: 400,
    compressionCount: 1, truncatedArtifactCount: 2, includedFileCount: 1, usageRatio: 0.5,
    automaticCompression: true, generatedAt: Date.now(), estimator: "conservative"
  }, {
    version: 1, coveredMessageIds: ["raw-message-1"], generatedAt: Date.now(), currentUserGoal: "保留原始目标",
    confirmedDecisions: [], unresolvedQuestions: [], filesRead: ["src/a.ts"], filesModified: [], commands: [],
    planStatus: [], recentValidationFailures: [], pendingApproval: null
  });

  const loaded = await getTaskSession(session.id);
  assert.equal(loaded.contextBudgetSnapshot?.automaticCompression, true);
  assert.deepEqual(loaded.contextSummary?.coveredMessageIds, ["raw-message-1"]);
  assert.equal(loaded.agentMessages?.some((message) => message.id === "raw-message-1"), true);
});

test("agent message store wraps task session persistence", async () => {
  const { session } = await createIsolatedTaskSession("封装 Agent 消息存储");

  await appendAgentMessage(session.id, {
    id: "tool-result-message",
    role: "tool",
    toolCallId: "call-read",
    content: "{\"ok\":true}",
    createdAt: 1
  });

  assert.deepEqual(
    (await listAgentMessages(session.id)).map((message) => ({
      id: message.id,
      role: message.role,
      toolCallId: message.toolCallId,
      content: message.content,
      createdAt: message.createdAt
    })),
    [
      {
        id: "tool-result-message",
        role: "tool",
        toolCallId: "call-read",
        content: "{\"ok\":true}",
        createdAt: 1
      }
    ]
  );
});

test("deletes task session history entries", async () => {
  const { session } = await createIsolatedTaskSession("删除历史会话");

  await createTaskSession("保留的任务会话");
  const remaining = await deleteTaskSession(session.id);

  assert.equal(remaining.some((item) => item.id === session.id), false);
  assert.equal((await listTaskSessions()).some((item) => item.id === session.id), false);
  await assert.rejects(() => getTaskSession(session.id), /Task session not found/);
});

test("updates task session chat id for history replay", async () => {
  const { session } = await createIsolatedTaskSession("关联聊天会话");

  const updated = await updateTaskSessionChatId(session.id, "chat:test-history");

  assert.equal(updated?.chatId, "chat:test-history");
  assert.equal((await getTaskSession(session.id)).chatId, "chat:test-history");
});

test("initializes fallback task plans for edit tasks", async () => {
  const { session } = await createIsolatedTaskSession("新增自动计划能力");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const planned = await initializeTaskPlan(session, {
      intent: "edit",
      confidence: 0.9,
      normalizedGoal: "新增自动计划能力",
      reason: "test"
    });

    assert.ok((planned?.planItems?.length || 0) >= 3);
    assert.equal(planned?.workflow?.type, "feature");
    assert.equal(planned?.planItems?.[0]?.status, "in_progress");
    assert.equal(planned?.planItems?.[1]?.status, "pending");
    assert.equal(planned?.planApproval?.status, "pending");
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("approves pending task plans", async () => {
  const { session } = await createIsolatedTaskSession("实现审批模式");
  await setTaskPlanItems(session.id, [{ title: "确认方案" }], { requireApproval: true });

  const approved = await approveTaskSessionPlan(session.id);

  assert.equal(approved?.planApproval?.status, "approved");
  assert.equal(typeof approved?.planApproval?.approvedAt, "number");
});

test("interrupts a running task into replan mode and resumes after approval", async () => {
  const { session } = await createIsolatedTaskSession("approve tool action");
  await setTaskPlanItems(session.id, [{ title: "inspect context" }, { title: "apply patch" }]);

  const interrupted = await interruptTaskSessionForReplan(session.id, "revise plan");

  assert.equal(interrupted?.status, "awaiting_replan");
  assert.equal(interrupted?.planApproval?.status, "pending");
  assert.equal(interrupted?.planItems?.[0]?.status, "blocked");
  assert.equal(interrupted?.planRevisions?.[0]?.trigger, "user");

  const resumed = await approveTaskSessionPlan(session.id);

  assert.equal(resumed?.status, "running");
  assert.equal(resumed?.planApproval?.status, "approved");
});

test("skips task plans for simple chat and command tasks", async () => {
  const { session } = await createIsolatedTaskSession("解释这个函数是什么意思");
  const chatClassification = {
    intent: "chat" as const,
    confidence: 0.9,
    normalizedGoal: "解释这个函数是什么意思",
    reason: "test"
  };

  assert.equal(shouldInitializeTaskPlan(session.userGoal, chatClassification), false);
  const chatSession = await initializeTaskPlan(session, chatClassification);
  assert.equal(chatSession?.workflow?.type, "analysis-only");
  assert.deepEqual(chatSession?.planItems, []);

  assert.equal(
    shouldInitializeTaskPlan("运行测试", {
      intent: "command",
      confidence: 0.9,
      normalizedGoal: "运行测试",
      reason: "test"
    }),
    false
  );

  const { session: commandSession } = await createIsolatedTaskSession("运行测试");
  const initializedCommandSession = await initializeTaskPlan(commandSession, {
    intent: "command",
    confidence: 0.9,
    normalizedGoal: "运行测试",
    reason: "test"
  });
  assert.equal(initializedCommandSession?.workflow, undefined);
  assert.deepEqual(initializedCommandSession?.planItems, []);
});

test("requires task plans for edit tasks before code changes", async () => {
  const { session: simpleSession } = await createIsolatedTaskSession("淇敼鎸夐挳棰滆壊");
  const simpleEditClassification = {
    intent: "edit" as const,
    confidence: 0.9,
    normalizedGoal: "淇敼鎸夐挳棰滆壊",
    reason: "test"
  };

  assert.equal(shouldInitializeTaskPlan(simpleSession.userGoal, simpleEditClassification, { selectedPath: "apps/web/src/App.tsx", contextFileCount: 1 }), true);

  const previousAiApiKeyForSimple = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const plannedSimple = await initializeTaskPlan(simpleSession, simpleEditClassification, { selectedPath: "apps/web/src/App.tsx", contextFileCount: 1 });
    assert.ok((plannedSimple?.planItems?.length || 0) > 0);
    assert.equal(plannedSimple?.planApproval?.status, "pending");
  } finally {
    config.aiApiKey = previousAiApiKeyForSimple;
  }

  const { session: complexSession } = await createIsolatedTaskSession("淇鏋勫缓澶辫触骞舵洿鏂板涓枃浠剁殑瀵煎叆");
  const complexEditClassification = {
    intent: "diagnose_then_edit" as const,
    confidence: 0.9,
    normalizedGoal: "淇鏋勫缓澶辫触骞舵洿鏂板涓枃浠剁殑瀵煎叆",
    reason: "test"
  };
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const planned = await initializeTaskPlan(complexSession, complexEditClassification, { contextFileCount: 2 });
    assert.ok((planned?.planItems?.length || 0) > 0);
    assert.equal(planned?.planApproval?.status, "pending");
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("initializes task plans for explicit planning requests", async () => {
  const { session } = await createIsolatedTaskSession("先给我一个实现计划");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const planned = await initializeTaskPlan(session, {
      intent: "chat",
      confidence: 0.8,
      normalizedGoal: "先给我一个实现计划",
      reason: "test"
    });

    assert.ok((planned?.planItems?.length || 0) > 0);
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("creates analysis-only fallback plans for inspect tasks", () => {
  const items = createFallbackTaskPlan("分析为什么构建失败", "inspect");

  assert.deepEqual(
    items.map((item) => item.title),
    ["明确分析问题", "收集相关证据", "分析原因与影响", "输出结论与建议"]
  );
});

test("persists bugfix workflow selection with its required phases", async () => {
  const { session } = await createIsolatedTaskSession("修复构建失败");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const planned = await initializeTaskPlan(session, {
      intent: "diagnose_then_edit",
      confidence: 0.95,
      normalizedGoal: "修复构建失败",
      reason: "test"
    });

    assert.equal(planned?.workflow?.type, "bugfix");
    assert.deepEqual(
      planned?.planItems?.map((item) => item.title),
      ["收集问题现象", "尝试复现问题", "定位问题根因", "实施最小修复", "补充回归测试", "执行回归验证"]
    );
    const persistedWorkflow = (await getTaskSession(session.id)).workflow;
    assert.equal(persistedWorkflow?.steps[0]?.id, "collect-symptoms");
    assert.deepEqual(persistedWorkflow?.authorization, {
      workspaceMutation: true,
      commandExecution: true,
      source: "workflow"
    });
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("advances feature workflow by stable step ids and completes summary", async () => {
  const { session } = await createIsolatedTaskSession("新增导出功能");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const planned = await initializeTaskPlan(session, {
      intent: "edit",
      confidence: 0.9,
      normalizedGoal: "新增导出功能",
      reason: "test"
    });
    assert.deepEqual(planned?.planItems?.map((item) => item.workflowStepId), ["analyze-project", "find-patterns", "plan-files", "implement", "validate", "summarize"]);

    const generated = await advanceTaskPlanProgress(session.id, "patch_generated");
    assert.deepEqual(generated?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "in_progress", "pending", "pending"]);

    const applied = await advanceTaskPlanProgress(session.id, "patch_applied");
    assert.deepEqual(applied?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "completed", "in_progress", "pending"]);

    const validated = await advanceTaskPlanProgress(session.id, "validation_success");
    assert.deepEqual(validated?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "completed", "completed", "completed"]);
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("advances bugfix and refactor workflows through their complete lifecycles", async () => {
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    for (const scenario of [
      { goal: "修复登录失败", intent: "diagnose_then_edit" as const, workflow: "bugfix" },
      { goal: "重构任务存储", intent: "edit" as const, workflow: "refactor" }
    ]) {
      const { session } = await createIsolatedTaskSession(scenario.goal);
      const planned = await initializeTaskPlan(session, {
        intent: scenario.intent,
        confidence: 0.9,
        normalizedGoal: scenario.goal,
        reason: "test"
      });

      assert.equal(planned?.workflow?.type, scenario.workflow);
      const generated = await advanceTaskPlanProgress(session.id, "patch_generated");
      assert.equal(generated?.planItems?.[3]?.status, "in_progress");
      const applied = await advanceTaskPlanProgress(session.id, "patch_applied");
      assert.equal(applied?.planItems?.[4]?.status, "in_progress");
      const validated = await advanceTaskPlanProgress(session.id, "validation_success");
      assert.equal(validated?.planItems?.every((item) => item.status === "completed"), true);
    }
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("advances edit task plan by semantic agent phases", async () => {
  const { session } = await createIsolatedTaskSession("推进编辑计划状态");
  await setTaskPlanItems(session.id, [
    { title: "理解需求目标" },
    { title: "检索并读取相关文件" },
    { title: "生成可审查修改" },
    { title: "应用修改并检查结果" },
    { title: "运行验证命令" }
  ]);

  const afterPatch = await advanceTaskPlanProgress(session.id, "patch_generated");
  assert.deepEqual(afterPatch?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "in_progress", "pending"]);

  const afterApply = await advanceTaskPlanProgress(session.id, "patch_applied");
  assert.deepEqual(afterApply?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "completed", "in_progress"]);

  const afterValidation = await advanceTaskPlanProgress(session.id, "validation_success");
  assert.deepEqual(afterValidation?.planItems?.map((item) => item.status), ["completed", "completed", "completed", "completed", "completed"]);
});

test("keeps validation active when a compact edit plan has no apply step", async () => {
  const { session } = await createIsolatedTaskSession("紧凑编辑计划状态");
  await setTaskPlanItems(session.id, [{ title: "理解目标" }, { title: "生成修改" }, { title: "运行验证" }]);

  const afterPatch = await advanceTaskPlanProgress(session.id, "patch_generated");
  assert.deepEqual(afterPatch?.planItems?.map((item) => item.status), ["completed", "completed", "in_progress"]);

  const afterApply = await advanceTaskPlanProgress(session.id, "patch_applied");
  assert.deepEqual(afterApply?.planItems?.map((item) => item.status), ["completed", "completed", "in_progress"]);
});

test("keeps repeated runtime progress events idempotent", async () => {
  const { session } = await createIsolatedTaskSession("重复 Runtime 进度事件");
  await setTaskPlanItems(session.id, [
    { workflowStepId: "analyze-project", title: "分析项目" },
    { workflowStepId: "implement", title: "实现修改" },
    { workflowStepId: "validate", title: "运行验证" },
    { workflowStepId: "summarize", title: "总结结果" }
  ]);

  const firstApply = await advanceTaskPlanProgress(session.id, "patch_applied");
  const repeatedApply = await advanceTaskPlanProgress(session.id, "patch_applied");
  assert.deepEqual(repeatedApply?.planItems?.map((item) => item.status), ["completed", "completed", "in_progress", "pending"]);
  assert.equal(repeatedApply?.updatedAt, firstApply?.updatedAt);

  const firstFailure = await advanceTaskPlanProgress(session.id, "validation_failed");
  const repeatedFailure = await advanceTaskPlanProgress(session.id, "validation_failed");
  assert.equal(repeatedFailure?.planItems?.filter((item) => item.title === "根据验证反馈调整计划").length, 1);
  assert.equal(repeatedFailure?.planRevisions?.length, firstFailure?.planRevisions?.length);
  assert.equal(repeatedFailure?.updatedAt, firstFailure?.updatedAt);

  const { session: cancelledSession } = await createIsolatedTaskSession("重复取消事件");
  await setTaskPlanItems(cancelledSession.id, [{ title: "运行任务" }, { title: "输出总结" }]);
  const firstCancellation = await advanceTaskPlanProgress(cancelledSession.id, "task_cancelled");
  const repeatedCancellation = await advanceTaskPlanProgress(cancelledSession.id, "task_cancelled");
  assert.deepEqual(repeatedCancellation?.planItems?.map((item) => item.status), ["blocked", "pending"]);
  assert.equal(repeatedCancellation?.updatedAt, firstCancellation?.updatedAt);
});

test("持久化 Runtime 成功证据会校准系统计划且重复执行不产生物理写入", async () => {
  const { session } = await createIsolatedTaskSession("从持久化证据恢复计划");
  await setTaskPlanItems(session.id, [
    { workflowStepId: "analyze-project", title: "分析项目" },
    { workflowStepId: "implement", title: "实现修改", note: "保留人工备注" },
    { title: "用户补充的人工检查", note: "不得自动完成" },
    { workflowStepId: "validate", title: "运行验证" },
    { workflowStepId: "summarize", title: "总结结果" }
  ]);
  const runtimeEvidence = {
    taskRunId: session.runtimeEvidence!.taskRunId,
    appliedFilePaths: ["src/recovered.ts"],
    generatedPatchIds: [],
    lastMutationAt: 100,
    lastValidationAt: 200,
    lastValidationStatus: "success" as const
  };
  await setTaskSessionRuntimeEvidence(session.id, runtimeEvidence);
  await clearTaskMetricsForTest({ key: session.id });

  const first = await reconcileTaskPlanFromRuntimeEvidence(session.id, { runtimeEvidence });
  const metricsAfterFirst = await getTaskSessionPersistenceMetrics(session.id);
  const repeated = await reconcileTaskPlanFromRuntimeEvidence(session.id, { runtimeEvidence });
  const metricsAfterRepeated = await getTaskSessionPersistenceMetrics(session.id);

  assert.deepEqual(first?.planItems?.map((item) => item.status), ["completed", "completed", "pending", "completed", "completed"]);
  assert.equal(first?.planItems?.[1]?.note, "保留人工备注");
  assert.equal(first?.planItems?.[2]?.note, "不得自动完成");
  assert.equal(repeated?.updatedAt, first?.updatedAt);
  assert.equal(metricsAfterRepeated.taskSessionPhysicalWriteCount, metricsAfterFirst.taskSessionPhysicalWriteCount);
  assert.equal((await getTaskSession(session.id)).runtimeEvidence?.lastValidationStatus, "success");
});

test("迟到或跨运行的 Runtime 快照不会回退当前持久化证据", async () => {
  const { session } = await createIsolatedTaskSession("拒绝过期 Runtime 快照");
  const taskRunId = session.runtimeEvidence!.taskRunId;
  await setTaskSessionRuntimeEvidence(session.id, {
    taskRunId,
    appliedFilePaths: ["src/newest.ts"],
    generatedPatchIds: ["patch-newest"],
    lastMutationAt: 200,
    lastValidationAt: 300,
    lastValidationStatus: "success"
  });

  await setTaskSessionRuntimeEvidence(session.id, {
    taskRunId,
    appliedFilePaths: ["src/older.ts"],
    generatedPatchIds: ["patch-older"],
    lastMutationAt: 100,
    lastValidationAt: 150,
    lastValidationStatus: "failed"
  });
  await setTaskSessionRuntimeEvidence(session.id, {
    taskRunId: "stale-task-run",
    appliedFilePaths: ["src/foreign.ts"],
    generatedPatchIds: ["patch-foreign"],
    lastMutationAt: 1_000,
    lastValidationAt: 2_000,
    lastValidationStatus: "failed"
  });

  const persisted = (await getTaskSession(session.id)).runtimeEvidence;
  assert.equal(persisted?.taskRunId, taskRunId);
  assert.deepEqual(persisted?.appliedFilePaths, ["src/newest.ts", "src/older.ts"]);
  assert.deepEqual(persisted?.generatedPatchIds, ["patch-newest", "patch-older"]);
  assert.equal(persisted?.lastMutationAt, 200);
  assert.equal(persisted?.lastValidationAt, 300);
  assert.equal(persisted?.lastValidationStatus, "success");
});

test("瞬时成功状态不能替代缺失的持久化验证结果", async () => {
  const { session } = await createIsolatedTaskSession("成功校准只信任落盘证据");
  await setTaskPlanItems(session.id, [
    { workflowStepId: "implement", title: "实现修改" },
    { workflowStepId: "validate", title: "运行验证" },
    { workflowStepId: "summarize", title: "总结结果" }
  ]);
  await setTaskSessionRuntimeEvidence(session.id, {
    taskRunId: session.runtimeEvidence!.taskRunId,
    appliedFilePaths: ["src/unverified.ts"],
    generatedPatchIds: [],
    lastMutationAt: 100,
    lastValidationAt: 200
  });

  const reconciled = await reconcileTaskPlanFromRuntimeEvidence(session.id, { validationStatus: "success" });
  assert.deepEqual(reconciled?.planItems?.map((item) => item.status), ["completed", "in_progress", "pending"]);
});

test("持久化校准保持未验证修改门禁并拒绝过期验证", async () => {
  for (const evidence of [
    { lastMutationAt: 200, lastValidationAt: undefined, lastValidationStatus: undefined },
    { lastMutationAt: 200, lastValidationAt: 200, lastValidationStatus: "success" as const }
  ]) {
    const { session } = await createIsolatedTaskSession("未验证修改不得完成");
    await setTaskPlanItems(session.id, [
      { workflowStepId: "analyze-project", title: "分析项目" },
      { workflowStepId: "implement", title: "实现修改" },
      { workflowStepId: "validate", title: "运行验证" },
      { workflowStepId: "summarize", title: "总结结果" }
    ]);
    await setTaskSessionRuntimeEvidence(session.id, {
      taskRunId: session.runtimeEvidence!.taskRunId,
      appliedFilePaths: ["src/stale.ts"],
      generatedPatchIds: [],
      ...evidence
    });

    const reconciled = await reconcileTaskPlanFromRuntimeEvidence(session.id);
    assert.deepEqual(reconciled?.planItems?.map((item) => item.status), ["completed", "completed", "in_progress", "pending"]);
  }
});

test("验证完成后的新修改会把系统计划退回验证阶段", async () => {
  const { session } = await createIsolatedTaskSession("修改后重新验证");
  await setTaskPlanItems(session.id, [
    { workflowStepId: "implement", title: "实现修改" },
    { workflowStepId: "validate", title: "运行验证" },
    { workflowStepId: "summarize", title: "总结结果" }
  ]);
  const taskRunId = session.runtimeEvidence!.taskRunId;
  await setTaskSessionRuntimeEvidence(session.id, {
    taskRunId,
    appliedFilePaths: ["src/revalidated.ts"],
    generatedPatchIds: [],
    lastMutationAt: 100,
    lastValidationAt: 200,
    lastValidationStatus: "success"
  });
  const completed = await reconcileTaskPlanFromRuntimeEvidence(session.id);
  assert.deepEqual(completed?.planItems?.map((item) => item.status), ["completed", "completed", "completed"]);

  await setTaskSessionRuntimeEvidence(session.id, {
    taskRunId,
    appliedFilePaths: ["src/revalidated.ts"],
    generatedPatchIds: [],
    lastMutationAt: 300,
    lastValidationAt: 200,
    lastValidationStatus: "success"
  });
  const stale = await reconcileTaskPlanFromRuntimeEvidence(session.id);

  assert.deepEqual(stale?.planItems?.map((item) => item.status), ["completed", "in_progress", "pending"]);
  assert.equal((stale?.runtimeEvidence?.lastValidationAt ?? 0) < (stale?.runtimeEvidence?.lastMutationAt ?? 0), true);
});

test("待审批、运行中命令、失败工具和人工阻塞均禁止成功校准", async () => {
  for (const blocker of ["pending", "active", "failed", "blocked"] as const) {
    const { session } = await createIsolatedTaskSession(`校准阻塞-${blocker}`);
    await setTaskPlanItems(session.id, [
      { workflowStepId: "analyze-project", title: "分析项目" },
      { workflowStepId: "implement", title: "实现修改", status: blocker === "blocked" ? "blocked" : "pending" },
      { workflowStepId: "validate", title: "运行验证" },
      { workflowStepId: "summarize", title: "总结结果" }
    ]);
    const runtimeEvidence = {
      taskRunId: session.runtimeEvidence!.taskRunId,
      appliedFilePaths: ["src/blocked.ts"],
      generatedPatchIds: [],
      lastMutationAt: 100,
      lastValidationAt: 200,
      lastValidationStatus: "success" as const
    };
    await setTaskSessionRuntimeEvidence(session.id, runtimeEvidence);
    if (blocker === "pending") {
      await setTaskSessionPendingToolCall(session.id, {
        actionId: "approval-blocker",
        toolCallId: "tool-blocker",
        toolName: "runCommand",
        arguments: { command: "pnpm test" },
        riskLevel: "medium"
      });
    }
    const before = await getTaskSession(session.id);
    const reconciled = await reconcileTaskPlanFromRuntimeEvidence(session.id, {
      runtimeEvidence,
      activeCommandCount: blocker === "active" ? 1 : 0,
      failedToolCallCount: blocker === "failed" ? 1 : 0
    });
    assert.deepEqual(reconciled?.planItems, before.planItems);
  }
});

test("失败验证只生成一次重规划修订且不完成验证", async () => {
  const { session } = await createIsolatedTaskSession("失败证据恢复");
  await setTaskPlanItems(session.id, [
    { workflowStepId: "implement", title: "实现修改" },
    { workflowStepId: "validate", title: "运行验证" },
    { workflowStepId: "summarize", title: "总结结果" }
  ]);
  const runtimeEvidence = {
    taskRunId: session.runtimeEvidence!.taskRunId,
    appliedFilePaths: ["src/failed.ts"],
    generatedPatchIds: [],
    lastMutationAt: 100,
    lastValidationAt: 200,
    lastValidationStatus: "failed" as const
  };
  await setTaskSessionRuntimeEvidence(session.id, runtimeEvidence);

  const first = await reconcileTaskPlanFromRuntimeEvidence(session.id, { runtimeEvidence });
  const repeated = await reconcileTaskPlanFromRuntimeEvidence(session.id, { runtimeEvidence });

  assert.equal(first?.planItems?.find((item) => item.workflowStepId === "validate")?.status === "completed", false);
  assert.equal(repeated?.planItems?.filter((item) => item.title === "根据验证反馈调整计划").length, 1);
  assert.equal(repeated?.planRevisions?.length, first?.planRevisions?.length);
  assert.equal(repeated?.updatedAt, first?.updatedAt);
});


test("updates approval request status by action id", async () => {
  const { session } = await createIsolatedTaskSession("approve tool action");
  await appendTaskSessionStep(session.id, {
    id: "approval-step",
    type: "approval_request",
    actionId: "edit_files:test-action",
    actionType: "edit_files",
    title: "Generate file changes",
    summary: "Wait for the user to approve the patch.",
    riskLevel: "medium",
    status: "pending",
    targets: ["src/App.tsx"],
    createdAt: Date.now()
  });

  const approved = await decideTaskSessionApproval(session.id, "edit_files:test-action", "approved");
  const step = approved?.steps.find((item) => item.type === "approval_request" && item.actionId === "edit_files:test-action");

  assert.equal(step?.type, "approval_request");
  assert.equal(step?.status, "approved");
  assert.equal((await getTaskSession(session.id)).steps.find((item) => item.id === "approval-step")?.type, "approval_request");
});

test("stores and clears pending tool calls for approval resume", async () => {
  const { session } = await createIsolatedTaskSession("等待工具审批");
  await appendTaskSessionStep(session.id, {
    id: "approval-step",
    type: "approval_request",
    actionId: "run_command:test-action",
    actionType: "run_command",
    title: "运行验证",
    summary: "等待用户批准命令。",
    riskLevel: "medium",
    status: "pending",
    command: "pnpm test",
    createdAt: Date.now()
  });

  const pending = await setTaskSessionPendingToolCall(session.id, {
    actionId: "run_command:test-action",
    toolCallId: "tool-call-1",
    toolName: "runCommand",
    arguments: { command: "pnpm test" },
    riskLevel: "medium",
    agentContext: {
      userGoal: "运行测试", filesRead: ["src/service.ts"], searchQueries: ["impact:src/service.ts"], searchResultFiles: [], relevantFiles: ["src/service.ts"],
      negativeEvidence: [{ kind: "path_absent", query: "router", scope: "src", sourceTool: "searchFilesByName", exhaustive: true, createdAt: 1 }]
    }
  });

  assert.equal(pending?.status, "awaiting_approval");
  assert.equal(pending?.pendingToolCall?.toolName, "runCommand");
  assert.deepEqual(pending?.pendingToolCall?.agentContext?.filesRead, ["src/service.ts"]);
  assert.deepEqual(pending?.pendingToolCall?.agentContext?.negativeEvidence, [
    { kind: "path_absent", query: "router", scope: "src", sourceTool: "searchFilesByName", exhaustive: true, createdAt: 1 }
  ]);
  assert.deepEqual(await getPendingAgentToolCall(session.id), pending?.pendingToolCall);

  await recordTaskSessionContextBudget(session.id, {
    modelContextWindowTokens: 1_000, reservedOutputTokens: 100, reservedToolSchemaTokens: 50, safetyMarginTokens: 50,
    availableInputTokens: 800, estimatedInputTokensBeforeCompression: 900, estimatedInputTokensAfterCompression: 400,
    compressionCount: 1, truncatedArtifactCount: 1, includedFileCount: 1, usageRatio: 0.5,
    automaticCompression: true, generatedAt: Date.now(), estimator: "conservative"
  }, {
    version: 1, coveredMessageIds: [], generatedAt: Date.now(), currentUserGoal: "运行测试",
    confirmedDecisions: [], unresolvedQuestions: [], filesRead: [], filesModified: [], commands: [],
    planStatus: [], recentValidationFailures: [],
    pendingApproval: { actionId: "run_command:test-action", toolName: "runCommand", arguments: { command: "pnpm test" } }
  });

  const approved = await decideTaskSessionApproval(session.id, "run_command:test-action", "approved");

  assert.equal(approved?.status, "running");
  assert.equal(approved?.pendingToolCall, null);
  assert.equal(approved?.contextSummary?.pendingApproval, null);
  assert.equal(await getPendingAgentToolCall(session.id), null);
});

test("clears pending tool calls through agent message store facade", async () => {
  const { session } = await createIsolatedTaskSession("清理等待工具调用");
  await setPendingAgentToolCall(session.id, {
    actionId: "edit_files:test-action",
    toolCallId: "tool-call-2",
    toolName: "proposePatch",
    arguments: { files: ["src/App.tsx"] },
    riskLevel: "medium"
  });

  const cleared = await clearPendingAgentToolCall(session.id, "edit_files:test-action");

  assert.equal(cleared?.status, "running");
  assert.equal(cleared?.pendingToolCall, null);
});

test("links agent steps to active task plan item evidence", async () => {
  const { session } = await createIsolatedTaskSession("记录执行证据");
  await setTaskPlanItems(session.id, [{ title: "读取文件" }, { title: "生成修改" }]);

  const updated = await appendTaskSessionStep(session.id, {
    id: "read-step",
    type: "tool_result",
    toolName: "readFile",
    output: { filePath: "src/App.tsx" },
    createdAt: Date.now()
  });

  assert.deepEqual(updated?.planItems?.[0]?.evidence?.stepIds, ["read-step"]);
  assert.deepEqual(updated?.planItems?.[0]?.evidence?.files, ["src/App.tsx"]);
});

test("rewrites task plans from natural language instructions with fallback rules", async () => {
  const { session } = await createIsolatedTaskSession("调整任务计划");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";

  try {
    const planned = await setTaskPlanItems(session.id, [{ title: "第一步" }, { title: "第二步" }, { title: "第三步" }]);
    const rewritten = await rewriteTaskPlanWithInstruction(planned!, "删除第 2 步");

    assert.deepEqual(rewritten?.planItems?.map((item) => item.title), ["第一步", "第三步"]);
  } finally {
    config.aiApiKey = previousAiApiKey;
  }
});

test("阶段 2 将计划按顺序转换为交付单元，且不猜测文件范围或依赖", () => {
  const planItems = [
    { id: "plan-analyze", workflowStepId: "analyze-project", title: "分析项目", status: "in_progress" as const, evidence: { stepIds: [], files: [], commands: [] }, createdAt: 1, updatedAt: 1 },
    { id: "plan-implement", workflowStepId: "implement", title: "实现变更", status: "pending" as const, evidence: { stepIds: [], files: [], commands: [] }, createdAt: 1, updatedAt: 1 },
    { id: "plan-validate", workflowStepId: "validate", title: "运行验证", status: "pending" as const, evidence: { stepIds: [], files: [], commands: [] }, createdAt: 1, updatedAt: 1 }
  ];
  const units = buildDeliveryUnitsFromTaskPlan(planItems, undefined, [], 2);

  assert.deepEqual(units.map((unit) => unit.sourcePlanItemIds), [["plan-analyze"], ["plan-implement"], ["plan-validate"]]);
  assert.deepEqual(units.map((unit) => unit.status), ["active", "pending", "pending"]);
  assert.deepEqual(units.flatMap((unit) => unit.dependencyUnitIds), []);
  assert.deepEqual(units.flatMap((unit) => unit.candidateFiles), []);
  assert.match(units[1]!.completionCriteria[0]!, /补丁|变更/);
  assert.match(units[2]!.completionCriteria[0]!, /验证命令/);
});

test("阶段 2 初始化和重写计划会同步交付单元并保留已完成单元证据", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("实现交付单元计划");
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";
  try {
    const initialized = await initializeTaskPlan(session, { intent: "edit", confidence: 1, normalizedGoal: session.userGoal, reason: "test" });
    assert.equal(initialized?.deliveryUnits?.length, initialized?.planItems?.length);
    assert.equal(initialized?.deliveryUnits?.[0]?.status, "active");

    const firstUnit = initialized!.deliveryUnits![0]!;
    const firstPlan = initialized!.planItems![0]!;
    const completed = await completeTaskSessionDeliveryUnit(session.id, firstUnit.id, "已形成并验证分析结论");
    const rewritten = await rewriteTaskPlanWithInstruction(completed!, "将第 2 步提前");
    const preservedUnit = rewritten?.deliveryUnits?.find((unit) => unit.sourcePlanItemIds.includes(firstPlan.id));

    assert.equal(preservedUnit?.id, firstUnit.id);
    assert.equal(preservedUnit?.status, "validated");
    assert.equal(rewritten?.planRevisions?.[0]?.reason, "将第 2 步提前");
    assert.equal(rewritten?.activeDeliveryUnitId, rewritten?.deliveryUnits?.find((unit) => unit.status === "active")?.id);
  } finally {
    config.aiApiKey = previousAiApiKey;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("生产计划入口优先使用带 Explorer 的规划协调能力", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("探索后规划认证系统");
  let explorationPlanningCalls = 0;
  let rolloutKey: string | undefined;
  const previousAiApiKey = config.aiApiKey;
  config.aiApiKey = "";
  try {
    const planned = await initializeTaskPlan(session, {
      intent: "edit",
      confidence: 1,
      normalizedGoal: session.userGoal,
      reason: "需要仓库事实"
    }, {
      runtimePlanning: true,
      runtimePlanner: {
        async plan() {
          throw new Error("存在 planWithExploration 时不应调用普通 plan");
        },
        async planWithExploration(request) {
          explorationPlanningCalls += 1;
          rolloutKey = request.rolloutKey;
          return {
            decision: { intent: "code_change", complexity: "complex", route: "planned", requiredCapabilities: ["planning"] } as const,
            explorations: [{
              result: {
                taskId: "T1",
                status: "success" as const,
                summary: "认证入口已确认",
                facts: ["登录路由调用认证服务"],
                changedFiles: [],
                evidence: ["src/routes/auth.ts:12"],
                blockers: []
              },
              exploration: {
                summary: "认证入口已确认",
                relevantFiles: ["src/routes/auth.ts"],
                facts: [{ statement: "登录路由调用认证服务", evidence: ["src/routes/auth.ts:12"] }],
                unknowns: []
              },
              state: {
                goal: session.userGoal,
                completedTasks: ["T1"],
                failedTasks: [],
                changedFiles: [],
                facts: ["登录路由调用认证服务"],
                status: "completed" as const
              }
            }],
            planning: {
              status: "ready" as const,
              plan: {
                version: 1,
                goal: session.userGoal,
                assumptions: [],
                completionCriteria: ["认证事实已确认并形成计划"],
                tasks: [{
                  id: "T1", type: "explore" as const, goal: "确认认证事实", dependencies: [], requiredCapabilities: ["exploration"],
                  readScope: ["**"], writeScope: [], acceptanceCriteria: ["提供文件证据"], status: "pending" as const
                }]
              }
            }
          };
        }
      }
    });

    assert.equal(explorationPlanningCalls, 1);
    assert.equal(rolloutKey, session.id);
    assert.equal(planned?.plannerOutcome?.status, "ready");
    assert.equal(planned?.runtimePlan?.tasks[0]?.type, "explore");
    const restored = await getTaskSession(session.id);
    assert.equal(restored?.explorerArtifacts?.[0]?.taskId, "T1");
    assert.deepEqual(restored?.explorerArtifacts?.[0]?.result.relevantFiles, ["src/routes/auth.ts"]);
    assert.doesNotMatch(JSON.stringify(restored?.explorerArtifacts), /完整文件正文/);
  } finally {
    config.aiApiKey = previousAiApiKey;
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("阶段 2 验证失败重规划会新增交付单元且保留已验证单元", async () => {
  const { workspaceRoot, session } = await createIsolatedTaskSession("验证失败重规划");
  try {
    const planned = await setTaskPlanItems(session.id, [{ title: "分析" }, { title: "验证", status: "in_progress" }]);
    const firstPlan = planned!.planItems![0]!;
    await setTaskSessionDeliveryUnits(session.id, [{ id: "unit-analysis", title: "分析", sourcePlanItemIds: [firstPlan.id], status: "validated", completionCriteria: ["已验证"], candidateFiles: [], filesRead: [], plannedFiles: [], dependencyUnitIds: [], checkpointIds: [], verificationCommands: [] }]);
    const replan = await advanceTaskPlanProgress(session.id, "validation_failed");

    assert.equal(replan?.deliveryUnits?.find((unit) => unit.id === "unit-analysis")?.status, "validated");
    assert.equal(replan?.deliveryUnits?.some((unit) => unit.title.includes("根据验证反馈")), true);
    assert.equal(replan?.planRevisions?.[0]?.trigger, "validation");
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
});
