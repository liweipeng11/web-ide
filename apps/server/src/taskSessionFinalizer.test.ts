import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizeTaskSession } from "./taskSessionFinalizer.js";
import { createTaskSession, getTaskSession, setTaskPlanItems, setTaskSessionRuntimeEvidence, updateTaskSessionStatus } from "./taskSessionStore.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

async function withTaskSession(
  run: (sessionId: string) => Promise<void>
) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-task-finalizer-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  const session = await createTaskSession("验证统一任务状态出口");

  try {
    await run(session.id);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("Runtime 完成后统一写入 success 并保留完成证据", async () => {
  await withTaskSession(async (taskSessionId) => {
    const completionEvidence = {
      mutationExpected: false,
      changedFileCount: 0,
      generatedPatchCount: 0,
      pendingPlanCount: 0,
      blockedPlanCount: 0,
      validationStatus: "not_required" as const,
      pendingApprovalCount: 0,
      activeCommandCount: 0,
      failedToolCallCount: 0
    };
    const finalized = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "completed", completionEvidence, statusReason: "分析结果已交付" },
      source: "agent_runtime"
    });

    assert.equal(finalized?.status, "success");
    assert.equal(finalized?.runtimeStatus, "completed");
    assert.deepEqual(finalized?.completionEvidence, completionEvidence);
    assert.equal(finalized?.finalization?.source, "agent_runtime");
  });
});

test("等待审批保持非终态，审批恢复完成后才能进入 success", async () => {
  await withTaskSession(async (taskSessionId) => {
    const awaiting = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "awaiting_approval" },
      source: "agent_runtime"
    });
    assert.equal(awaiting?.status, "awaiting_approval");
    assert.equal(awaiting?.finalization, undefined);

    const completed = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "completed" },
      source: "agent_runtime"
    });
    assert.equal(completed?.status, "success");
  });
});

test("模型预算耗尽时暂停任务并写入可恢复续跑指引", async () => {
  await withTaskSession(async (taskSessionId) => {
    const paused = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "budget_exhausted", statusReason: "本轮输入 Token 已达到预算" },
      source: "provider_error"
    });

    assert.equal(paused?.status, "paused");
    assert.equal(paused?.runtimeStatus, "budget_exhausted");
    assert.equal(paused?.continuation?.nextStep, "continue_current_unit");
    assert.match(paused?.continuation?.message || "", /输入 Token/);
  });
});

test("finalize 前使用持久化成功证据补齐系统计划", async () => {
  await withTaskSession(async (taskSessionId) => {
    const session = await getTaskSession(taskSessionId);
    await setTaskPlanItems(taskSessionId, [
      { workflowStepId: "implement", title: "实现修改" },
      { workflowStepId: "validate", title: "运行验证" },
      { workflowStepId: "summarize", title: "总结结果" }
    ]);
    await setTaskSessionRuntimeEvidence(taskSessionId, {
      taskRunId: session.runtimeEvidence!.taskRunId,
      appliedFilePaths: ["src/finalize.ts"],
      generatedPatchIds: [],
      lastMutationAt: 100,
      lastValidationAt: 200,
      lastValidationStatus: "success"
    });

    const finalized = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: {
        status: "completed",
        completionEvidence: {
          mutationExpected: true,
          changedFileCount: 1,
          generatedPatchCount: 0,
          pendingPlanCount: 0,
          blockedPlanCount: 0,
          validationStatus: "passed",
          pendingApprovalCount: 0,
          activeCommandCount: 0,
          failedToolCallCount: 0,
          lastMutationAt: 100,
          lastValidationAt: 200
        }
      },
      source: "agent_runtime"
    });

    assert.equal(finalized?.status, "success");
    assert.equal(finalized?.planItems?.every((item) => item.status === "completed"), true);
  });
});

test("客户端断开优先映射 cancelled，Provider 错误映射 failed", async () => {
  await withTaskSession(async (taskSessionId) => {
    const cancelled = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "completed" },
      clientClosed: true,
      source: "legacy_chat"
    });
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.finalization?.source, "client_disconnect");
  });

  await withTaskSession(async (taskSessionId) => {
    const failed = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "failed" },
      source: "provider_error"
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.finalization?.source, "provider_error");
  });
});

test("重复 finalize 保留第一次终态且不更新时间", async () => {
  await withTaskSession(async (taskSessionId) => {
    const first = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "completed" },
      source: "agent_runtime"
    });
    const repeated = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "failed" },
      source: "provider_error"
    });

    assert.equal(repeated?.status, "success");
    assert.equal(repeated?.updatedAt, first?.updatedAt);
    assert.deepEqual(repeated?.finalization, first?.finalization);
    assert.deepEqual((await getTaskSession(taskSessionId)).finalization, first?.finalization);
  });
});

test("Plan 模式的编辑任务完成只暂停，只读分析任务才终结", async () => {
  await withTaskSession(async (taskSessionId) => {
    const paused = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "completed" },
      source: "plan_runtime",
      mode: "plan",
      workflowType: "feature"
    });
    assert.equal(paused?.status, "paused");
  });

  await withTaskSession(async (taskSessionId) => {
    const completed = await finalizeTaskSession({
      taskSessionId,
      runtimeResult: { status: "completed" },
      source: "plan_runtime",
      mode: "plan",
      workflowType: "analysis-only"
    });
    assert.equal(completed?.status, "success");
  });
});

test("传输正常结束本身不能证明任务完成，普通状态接口不能写终态", async () => {
  await withTaskSession(async (taskSessionId) => {
    await assert.rejects(
      finalizeTaskSession({ taskSessionId, source: "legacy_chat" }),
      /需要 Runtime 结果或明确的客户端断开信号/
    );
    await assert.rejects(updateTaskSessionStatus(taskSessionId, "success"), /必须通过 finalizeTaskSession/);
    assert.equal((await getTaskSession(taskSessionId)).status, "running");
  });
});
