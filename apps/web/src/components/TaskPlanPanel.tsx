import { useEffect, useState } from "react";
import type { AgentMode, AgentRuntimeStatus, DeliveryUnit, DeliveryUnitStatus, TaskContinuation, TaskPlanItem, TaskPlanItemStatus, TaskSession, TaskWorkflowType } from "../api";
import Icon from "./Icon";
import { getTaskTokenUsageText } from "./taskTokenUsage";

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
  onOpenTaskConversation?: () => void;
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
  no_progress: { label: "无进展停止", detail: "策略恢复后仍未获得新进展" },
  failed: { label: "执行失败", detail: "出现无法安全恢复的内部错误" }
};

const deliveryUnitStatusText: Record<DeliveryUnitStatus, string> = {
  pending: "后续单元",
  active: "当前单元",
  validated: "已完成单元",
  blocked: "阻塞单元",
  deferred: "可继续单元"
};

const taskPauseView: Partial<Record<TaskSession["status"], { label: string; detail: string }>> = {
  paused: { label: "计划已就绪", detail: "已完成只读调研。切换到 Act 后会在同一任务上下文中继续实施。" },
  incomplete: { label: "可继续暂停", detail: "本轮未完成，但已保留可复用事实和后续入口。" },
  awaiting_replan: { label: "等待重规划", detail: "当前事实不足以安全继续，请重规划或编辑计划。" },
  awaiting_user: { label: "等待你的决策", detail: "任务需要你回答具体问题或确认条件后才能继续。" },
  blocked: { label: "任务受阻", detail: "需要用户、权限或外部条件介入。" }
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

function getDeliveryUnitGroups(units: DeliveryUnit[]) {
  return (["active", "validated", "pending", "deferred", "blocked"] as const)
    .map((status) => ({ status, units: units.filter((unit) => unit.status === status) }))
    .filter((group) => group.units.length > 0);
}

function getContinuationLabel(continuation?: TaskContinuation) {
  if (!continuation) return "打开任务对话";
  if (continuation.nextStep === "replan") return "按建议重规划";
  if (continuation.nextStep === "await_user_input") return "打开对话并回答";
  if (continuation.nextStep === "resume_validation") return "继续验证";
  return "继续当前任务";
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
  onInterruptForReplan,
  onOpenTaskConversation
}: Props) {
  const [draftTitle, setDraftTitle] = useState("");
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [editingItemId, setEditingItemId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [editingNote, setEditingNote] = useState("");
  const [showPlanSteps, setShowPlanSteps] = useState(false);
  const planItems = session?.planItems || [];
  const deliveryUnits = session?.deliveryUnits || [];
  const deliveryUnitGroups = getDeliveryUnitGroups(deliveryUnits);
  const planRevisions = session?.planRevisions || [];
  const workflow = session?.workflow;
  const isAwaitingReplan = session?.status === "awaiting_replan";
  const effectiveAgentMode = session?.agentMode || agentMode || "act";
  const isPlanReadyForAct = session?.status === "paused" && effectiveAgentMode === "plan";
  const canEdit = Boolean(session) && !disabled && !loading;
  const canInterruptForReplan = Boolean(session) && Boolean(onInterruptForReplan) && streaming && !disabled;
  const canSubmitPlanAction = canEdit || canInterruptForReplan;
  const completedCount = countByStatus(planItems, "completed");
  const inProgressCount = countByStatus(planItems, "in_progress");
  const blockedCount = countByStatus(planItems, "blocked");
  const runtimeStatus = session?.runtimeStatus;
  const completionEvidence = session?.completionEvidence;
  const tokenUsage = getTaskTokenUsageText(session?.modelUsage);
  const taskFinished = session ? ["success", "incomplete", "blocked", "failed", "cancelled"].includes(session.status) : false;
  const pauseView = session ? taskPauseView[session.status] : undefined;
  // 有交付单元时优先展示 Runtime 批次；旧会话仍保持原计划步骤的直接可见性。
  const shouldShowPlanSteps = deliveryUnits.length === 0 || showPlanSteps;

  useEffect(() => {
    setEditingItemId("");
    setEditingTitle("");
    setEditingNote("");
    setDraftTitle("");
    setRewriteInstruction("");
    setShowPlanSteps(false);
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
        <span className={`task-plan-mode ${effectiveAgentMode}`}>{effectiveAgentMode === "plan" ? "规划阶段" : "实施阶段"}</span>
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

      {pauseView && (
        <div className={`task-continuation status-${session?.status}`} role="status">
          <div>
            <strong>{pauseView.label}</strong>
            <p>{session?.continuation?.message || session?.runtimeStatusReason || pauseView.detail}</p>
          </div>
          {session?.continuation?.requiredUserInputs.length ? (
            <ul aria-label="需要补充的信息">
              {session.continuation.requiredUserInputs.map((input) => (
                <li key={input.field}>{input.label}{input.required ? "（必填）" : "（可选）"}</li>
              ))}
            </ul>
          ) : null}
          {session?.status === "awaiting_replan" && (
            <div className="task-continuation-actions">
              <button type="button" disabled={!canEdit} onClick={() => void onRewritePlan("请基于已记录的事实、失败诊断和当前交付单元重新规划，保留已完成项。")}>
                按当前事实重规划
              </button>
              <button type="button" className="secondary" disabled={!canEdit} onClick={() => setRewriteInstruction("请调整计划后继续执行：")}>
                编辑计划后继续
              </button>
            </div>
          )}
          {session?.status !== "awaiting_replan" && (
            <div className="task-continuation-actions">
              {isPlanReadyForAct ? (
                <button type="button" disabled={disabled || loading} onClick={() => void onApprovePlan()}>
                  开始实施
                </button>
              ) : (
                <button type="button" disabled={disabled || loading} onClick={onOpenTaskConversation}>
                  {getContinuationLabel(session?.continuation)}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {taskFinished && tokenUsage && (
        <div className="task-token-usage" aria-label="本次任务 Token 消耗">
          <strong>本次任务 Token 消耗</strong>
          <span>{tokenUsage.summary}</span>
          <small>{tokenUsage.detail}</small>
        </div>
      )}

      {workflow && (
        <div className={`task-workflow-summary ${workflow.type}`} title={workflow.reason}>
          <strong>{workflowText[workflow.type]}</strong>
          <span>{workflow.reason}</span>
          <small>{Math.round(workflow.confidence * 100)}% 置信度 · {workflow.steps.length} 个阶段</small>
        </div>
      )}

      {deliveryUnitGroups.length > 0 && (
        <section className="delivery-unit-summary" aria-label="交付单元">
          <div className="delivery-unit-heading">
            <strong>交付单元</strong>
            <span>{deliveryUnits.length} 个批次{session?.activeDeliveryUnitId ? " · 已定位当前批次" : ""}</span>
          </div>
          {deliveryUnitGroups.map(({ status, units }) => (
            <div key={status} className={`delivery-unit-group status-${status}`}>
              <strong>{deliveryUnitStatusText[status]}（{units.length}）</strong>
              <ul>
                {units.map((unit) => (
                  <li key={unit.id} className={unit.id === session?.activeDeliveryUnitId ? "active" : ""}>
                    <span>{unit.title}</span>
                    {unit.candidateFiles.length > 0 && <small>{unit.candidateFiles.length} 个候选文件</small>}
                    {unit.verificationCommands.length > 0 && <small>{unit.verificationCommands.length} 个验证项</small>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {deliveryUnits.length > 0 && (
        <div className="task-plan-step-toggle">
          <div>
            <strong>计划步骤</strong>
            <span>{planItems.length} 项，可编辑；用于说明每个交付单元的来源计划。</span>
          </div>
          <button type="button" className="secondary" aria-expanded={showPlanSteps} onClick={() => setShowPlanSteps((current) => !current)}>
            {showPlanSteps ? "收起计划步骤" : "查看计划步骤"}
          </button>
        </div>
      )}

      {session?.planApproval?.status === "pending" && (
        <div className="task-plan-approval">
          <strong>{isAwaitingReplan ? "已返回规划阶段" : "计划等待确认"}</strong>
          <p>{isAwaitingReplan ? "当前执行已暂停，请先调整计划；确认后智能体会继续实施。" : "确认后智能体会按当前计划继续修改代码。"}</p>
          <button type="button" disabled={!canEdit} onClick={() => void onApprovePlan()}>
            {isAwaitingReplan ? "确认后继续实施" : "开始实施"}
          </button>
        </div>
      )}

      {session && shouldShowPlanSteps && (
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

      {session && shouldShowPlanSteps && (
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

      {shouldShowPlanSteps && (planItems.length ? (
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
      ))}

      {shouldShowPlanSteps && planRevisions.length > 0 && (
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
