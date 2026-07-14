import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { appendAgentMessage, clearPendingAgentToolCall, getPendingAgentToolCall, listAgentMessages, setPendingAgentToolCall } from "./agentMessageStore.js";
import { createCheckpoint } from "./checkpointStore.js";
import { projectRuntimeDirectory } from "./statePaths.js";
import { addTaskPlanItem, addTaskSessionCheckpoint, addTaskSessionFilesChanged, advanceTaskPlanProgress, appendTaskSessionAgentMessage, appendTaskSessionFileEditEvent, appendTaskSessionPatchEvent, appendTaskSessionStep, approveTaskSessionPlan, createTaskSession, decideTaskSessionApproval, deleteTaskPlanItem, deleteTaskSession, getTaskSession, interruptTaskSessionForReplan, listTaskSessions, recordTaskSessionPatchDiagnostics, setTaskPlanItems, setTaskSessionPendingToolCall, updateTaskPlanItem, updateTaskSessionChatId } from "./taskSessionStore.js";
import { setWorkspaceRoot } from "./workspaceStore.js";
import { createFallbackTaskPlan, initializeTaskPlan, rewriteTaskPlanWithInstruction, shouldInitializeTaskPlan } from "./taskPlanService.js";

async function createIsolatedTaskSession(userGoal = "实现任务计划器") {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-plan-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  return {
    workspaceRoot,
    session: await createTaskSession(userGoal)
  };
}

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
    assert.equal((await getTaskSession(session.id)).workflow?.steps[0]?.id, "collect-symptoms");
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
    agentContext: { userGoal: "运行测试", filesRead: ["src/service.ts"], searchQueries: ["impact:src/service.ts"], searchResultFiles: [], relevantFiles: ["src/service.ts"] }
  });

  assert.equal(pending?.status, "awaiting_approval");
  assert.equal(pending?.pendingToolCall?.toolName, "runCommand");
  assert.deepEqual(pending?.pendingToolCall?.agentContext?.filesRead, ["src/service.ts"]);
  assert.deepEqual(await getPendingAgentToolCall(session.id), pending?.pendingToolCall);

  const approved = await decideTaskSessionApproval(session.id, "run_command:test-action", "approved");

  assert.equal(approved?.status, "running");
  assert.equal(approved?.pendingToolCall, null);
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
