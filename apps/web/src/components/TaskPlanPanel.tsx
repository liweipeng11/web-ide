import { useEffect, useState } from "react";
import type { AgentMode, AgentRuntimeStatus, TaskPlanItem, TaskPlanItemStatus, TaskSession, TaskWorkflowType } from "../api";
import Icon from "./Icon";

type Props = {
  session: TaskSession | null;
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  agentMode?: AgentMode;
  compact?: boolean;
  onAddItem: (title: string) => Promise<void>;
  onUpdateItem: (itemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) => Promise<void>;
  onDeleteItem: (itemId: string) => Promise<void>;
  onRewritePlan: (instruction: string) => Promise<void>;
  onApprovePlan: () => Promise<void>;
  onInterruptForReplan?: (instruction: string) => Promise<void>;
};

const statusText: Record<TaskPlanItemStatus, string> = {
  pending: "待处理",
  in_progress: "进行中",
  completed: "已完成",
  blocked: "受阻"
};

// 统一维护计划步骤状态，避免界面分散写死状态值。
const statusOptions: TaskPlanItemStatus[] = ["pending", "in_progress", "completed", "blocked"];

const workflowText: Record<TaskWorkflowType, string> = {
  bugfix: "缺陷修复",
  feature: "功能开发",
  refactor: "代码重构",
  "analysis-only": "只读分析"
};

const runtimeStatusView: Record<AgentRuntimeStatus, { label: string; detail: string }> = {
  completed: { label: "已完成", detail: "交付条件已满足" },
  awaiting_approval: { label: "等待审批", detail: "补丁或工具操作已准备好" },
  incomplete: { label: "尚未完成，可继续", detail: "仍有可执行的恢复动作" },
  blocked: { label: "已阻塞，需要处理", detail: "需要用户、权限或外部条件介入" },
  step_limit_reached: { label: "达到步骤上限", detail: "本轮已停止，可继续任务" },
  no_progress: { label: "无进展停止", detail: "策略恢复后仍未获得新进展" }
};

function getRevisionTriggerText(trigger: string) {
  const triggerText: Record<string, string> = {
    user: "用户调整",
    agent: "智能体重规划",
    validation: "验证反馈",
    system: "系统记录"
  };

  return triggerText[trigger] || "计划调整";
}

function formatRevisionTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function countByStatus(items: TaskPlanItem[], status: TaskPlanItemStatus) {
  return items.filter((item) => item.status === status).length;
}

export default function TaskPlanPanel({
  session,
  loading,
  streaming,
  disabled,
  agentMode,
  compact = false,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onRewritePlan,
  onApprovePlan,
  onInterruptForReplan
}: Props) {
  const [draftTitle, setDraftTitle] = useState("");
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [editingItemId, setEditingItemId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const planItems = session?.planItems || [];
  const planRevisions = session?.planRevisions || [];
  const workflow = session?.workflow;
  const isAwaitingReplan = session?.status === "awaiting_replan";
  const effectiveAgentMode = session?.agentMode || agentMode || "act";
  const canEdit = Boolean(session) && !disabled && !loading;
  const canInterruptForReplan = Boolean(session) && Boolean(onInterruptForReplan) && streaming && !disabled;
  const canSubmitPlanAction = canEdit || canInterruptForReplan;
  const completedCount = countByStatus(planItems, "completed");
  const inProgressCount = countByStatus(planItems, "in_progress");
  const blockedCount = countByStatus(planItems, "blocked");
  const runtimeStatus = session?.runtimeStatus;
  const completionEvidence = session?.completionEvidence;

  useEffect(() => {
    setEditingItemId("");
    setEditingTitle("");
    setEditingNote("");
    setDraftTitle("");
    setRewriteInstruction("");
  }, [session?.id]);

  function startEditing(item: TaskPlanItem) {
    setEditingItemId(item.id);
    setEditingTitle(item.title);
    setEditingNote(item.note || "");
  }

  async function saveEditing(itemId: string) {
    const nextTitle = editingTitle.trim();

    if (!nextTitle) return;

    await onUpdateItem(itemId, {
      title: nextTitle,
      note: editingNote.trim()
    });
    setEditingItemId("");
    setEditingTitle("");
    setEditingNote("");
  }

  async function addItem() {
    const title = draftTitle.trim();

    if (!title) return;

    await onAddItem(title);
    setDraftTitle("");
  }

  async function submitPlanAction() {
    const instruction = rewriteInstruction.trim();

    // 执行中优先走“中断并进入计划模式”，贴近 Claude Code 的交互心智。
    if (canInterruptForReplan && onInterruptForReplan) {
      await onInterruptForReplan(instruction);
      setRewriteInstruction("");
      return;
    }

    if (!instruction) return;

    await onRewritePlan(instruction);
    setRewriteInstruction("");
  }

  return (
    <section className={compact ? "task-plan-panel compact" : "task-plan-panel"}>
      <div className="task-plan-heading">
        <div>
          <h3>任务计划</h3>
          <span>
            {planItems.length ? `${completedCount}/${planItems.length} 完成 · ${inProgressCount} 进行中 · ${blockedCount} 受阻` : session ? "暂无计划步骤" : "选择任务后可维护计划"}
          </span>
        </div>
        <span className={`task-plan-mode ${effectiveAgentMode}`}>{effectiveAgentMode === "plan" ? "Plan" : "Act"}</span>
      </div>

      {runtimeStatus && (
        <div className={`task-runtime-status status-${runtimeStatus}`} role="status">
          <div>
            <strong>{runtimeStatusView[runtimeStatus].label}</strong>
            <span>{session?.runtimeStatusReason || runtimeStatusView[runtimeStatus].detail}</span>
          </div>
          {completionEvidence && (
            <small>
              补丁 {completionEvidence.generatedPatchCount} · 已变更 {completionEvidence.changedFileCount} ·
              待处理 {completionEvidence.pendingPlanCount} · 阻塞 {completionEvidence.blockedPlanCount}
            </small>
          )}
        </div>
      )}

      {workflow && (
        <div className={`task-workflow-summary ${workflow.type}`} title={workflow.reason}>
          <strong>{workflowText[workflow.type]}</strong>
          <span>{workflow.reason}</span>
          <small>{Math.round(workflow.confidence * 100)}% 置信度 · {workflow.steps.length} 个阶段</small>
        </div>
      )}

      {session?.planApproval?.status === "pending" && (
        <div className="task-plan-approval">
          <strong>{isAwaitingReplan ? "已进入计划模式" : "计划等待批准"}</strong>
          <p>{isAwaitingReplan ? "当前执行已暂停，请先调整计划；确认后会切换到 Act 模式继续。" : "确认后智能体会进入 Act 模式，并按当前计划继续执行代码修改。"}</p>
          <button type="button" disabled={!canEdit} onClick={() => void onApprovePlan()}>
            {isAwaitingReplan ? "批准继续执行" : "批准执行"}
          </button>
        </div>
      )}

      {session && (
        <form
          className="task-plan-rewrite"
          onSubmit={(event) => {
            event.preventDefault();
            void submitPlanAction();
          }}
        >
          <input
            value={rewriteInstruction}
            disabled={!canSubmitPlanAction}
            placeholder={canInterruptForReplan ? "可选：说明为什么要暂停并重规划，例如：先确认路由版本再继续..." : "用一句话调整计划，例如：把测试提前、删除第 3 步..."}
            onChange={(event) => setRewriteInstruction(event.target.value)}
          />
          <button type="submit" disabled={!canSubmitPlanAction || (!canInterruptForReplan && !rewriteInstruction.trim())}>
            {canInterruptForReplan ? "中断并进入计划模式" : "调整计划"}
          </button>
        </form>
      )}

      {session && (
        <form
          className="task-plan-add"
          onSubmit={(event) => {
            event.preventDefault();
            void addItem();
          }}
        >
          <input value={draftTitle} disabled={!canEdit} placeholder="新增一个计划步骤..." onChange={(event) => setDraftTitle(event.target.value)} />
          <button type="submit" className="icon-button" disabled={!canEdit || !draftTitle.trim()} title="添加计划步骤" aria-label="添加计划步骤">
            <Icon name="send" />
          </button>
        </form>
      )}

      {planItems.length ? (
        <ol className="task-plan-list">
          {planItems.map((item) => {
            const isEditing = editingItemId === item.id;

            return (
              <li key={item.id} className={`task-plan-item ${item.status}`}>
                <select value={item.status} disabled={!canEdit} aria-label="计划状态" onChange={(event) => void onUpdateItem(item.id, { status: event.target.value as TaskPlanItemStatus })}>
                  {statusOptions.map((status) => (
                    <option key={status} value={status}>
                      {statusText[status]}
                    </option>
                  ))}
                </select>

                {isEditing ? (
                  <div className="task-plan-edit">
                    <input value={editingTitle} disabled={!canEdit} onChange={(event) => setEditingTitle(event.target.value)} />
                    <textarea value={editingNote} disabled={!canEdit} placeholder="备注，可选" onChange={(event) => setEditingNote(event.target.value)} />
                    <div className="task-plan-actions">
                      <button type="button" className="icon-button" disabled={!canEdit || !editingTitle.trim()} title="保存计划步骤" aria-label="保存计划步骤" onClick={() => void saveEditing(item.id)}>
                        <Icon name="save" />
                      </button>
                      <button type="button" className="icon-button" disabled={loading} title="取消编辑" aria-label="取消编辑" onClick={() => setEditingItemId("")}>
                        <Icon name="close" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="task-plan-content">
                    <strong>{item.title}</strong>
                    {item.note && <p>{item.note}</p>}
                    {((item.evidence?.files.length || 0) > 0 || (item.evidence?.commands.length || 0) > 0) && (
                      <div className="task-plan-evidence">
                        {(item.evidence?.files || []).slice(0, 4).map((file) => (
                          <code key={file}>{file}</code>
                        ))}
                        {(item.evidence?.commands || []).slice(0, 3).map((command) => (
                          <code key={command}>{command}</code>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {!isEditing && (
                  <div className="task-plan-actions">
                    <button type="button" className="icon-button" disabled={!canEdit} title="编辑计划步骤" aria-label="编辑计划步骤" onClick={() => startEditing(item)}>
                      <Icon name="edit" />
                    </button>
                    <button type="button" className="icon-button" disabled={!canEdit} title="删除计划步骤" aria-label="删除计划步骤" onClick={() => void onDeleteItem(item.id)}>
                      <Icon name="delete" />
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="task-plan-empty">{session ? "还没有计划步骤，可以先手动添加。后续 Agent Loop 会自动维护这里。" : "打开任务历史或开始一次智能体任务后，这里会显示计划。"}</p>
      )}

      {planRevisions.length > 0 && (
        <div className="task-plan-revisions" aria-label="计划修订记录">
          <strong>计划修订</strong>
          <ul>
            {planRevisions.slice(0, 4).map((revision) => (
              <li key={revision.id}>
                <span>{getRevisionTriggerText(revision.trigger)}</span>
                <p>{revision.reason}</p>
                <small>
                  {formatRevisionTime(revision.createdAt)} · {revision.beforeItems.length} 步变为 {revision.afterItems.length} 步
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
