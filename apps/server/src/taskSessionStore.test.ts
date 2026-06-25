import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { projectRuntimeDirectory } from "./statePaths.js";
import { addTaskPlanItem, advanceTaskPlanProgress, appendTaskSessionStep, approveTaskSessionPlan, createTaskSession, decideTaskSessionApproval, deleteTaskPlanItem, deleteTaskSession, getTaskSession, interruptTaskSessionForReplan, listTaskSessions, setTaskPlanItems, updateTaskPlanItem, updateTaskSessionChatId } from "./taskSessionStore.js";
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
  await fs.writeFile(sessionPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  const loaded = await getTaskSession(session.id);
  assert.deepEqual(loaded.planItems, []);
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
  assert.equal(await initializeTaskPlan(session, chatClassification), null);
  assert.deepEqual((await getTaskSession(session.id)).planItems, []);

  assert.equal(
    shouldInitializeTaskPlan("运行测试", {
      intent: "command",
      confidence: 0.9,
      normalizedGoal: "运行测试",
      reason: "test"
    }),
    false
  );
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

test("creates shorter fallback plans for inspect tasks", () => {
  const items = createFallbackTaskPlan("分析为什么构建失败", "inspect");

  assert.deepEqual(
    items.map((item) => item.title),
    ["理解问题和上下文", "检索相关代码和资料", "整理结论和建议"]
  );
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
