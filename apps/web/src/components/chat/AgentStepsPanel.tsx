import { useState } from "react";
import type { AgentStep } from "../../api";
import { getNumberField, getStringField, summarizeUnknown } from "./chatUtils";

type ApprovalStep = Extract<AgentStep, { type: "approval_request" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRuntimeApprovalStep(step: ApprovalStep) {
  return isRecord(step.details) && step.details.approvalSource === "agent_runtime";
}

function sanitizedResult(result: Extract<AgentStep, { type: "command" }>["result"]) {
  if (!result) return null;

  return {
    command: result.command,
    cwd: result.cwd,
    status: result.status,
    exitCode: result.exitCode,
    detectedUrl: result.detectedUrl,
    outputTruncated: result.outputTruncated
  };
}

function formatAgentStepDetail(step: AgentStep) {
  let detail: Record<string, unknown>;

  if (step.type === "approval_request") {
    detail = {
      type: step.type,
      actionId: step.actionId,
      actionType: step.actionType,
      title: step.title,
      summary: step.summary,
      riskLevel: step.riskLevel,
      status: step.status,
      targets: step.targets,
      command: step.command,
      details: step.details
    };
  } else if (step.type === "strategy") {
    detail = {
      type: step.type,
      event: step.event,
      message: step.message,
      toolName: step.toolName,
      repeatCount: step.repeatCount,
      currentStep: step.currentStep,
      maxSteps: step.maxSteps,
      facts: step.facts
    };
  } else if (step.type === "tool_call") {
    detail = { type: step.type, toolName: step.toolName, input: step.input };
  } else if (step.type === "tool_result") {
    detail = { type: step.type, toolName: step.toolName, output: step.output };
  } else if (step.type === "workflow_decision") {
    detail = {
      type: step.type,
      workflowType: step.workflowType,
      toolName: step.toolName,
      plannedFiles: step.plannedFiles,
      references: step.references,
      blockingReferences: step.blockingReferences,
      decision: step.decision,
      reason: step.reason,
      recommendedTools: step.recommendedTools,
      recoverable: step.recoverable,
      requiresUserAction: step.requiresUserAction
    };
  } else if (step.type === "edit") {
    detail = { type: step.type, files: step.files };
  } else if (step.type === "command") {
    detail = { type: step.type, command: step.command, status: step.status, policy: step.policy, result: sanitizedResult(step.result) };
  } else if (step.type === "checkpoint") {
    detail = { type: step.type, checkpointId: step.checkpointId, files: step.files, source: step.source };
  } else if (step.type === "message") {
    detail = { type: step.type, content: step.content };
  } else if (step.type === "completion_rejected") {
    detail = {
      type: step.type,
      completionStatus: step.completionStatus,
      rejectionCode: step.rejectionCode,
      message: step.message,
      suggestedAction: step.suggestedAction,
      shouldRecover: step.shouldRecover
    };
  } else if (step.type === "tool_blocked") {
    detail = { type: step.type, toolName: step.toolName, message: step.message };
  } else {
    detail = { type: step.type, message: step.message };
  }

  return JSON.stringify(
    {
      id: step.id,
      createdAt: new Date(step.createdAt).toISOString(),
      ...detail
    },
    null,
    2
  );
}

function getApprovalStatusText(status: ApprovalStep["status"]) {
  if (status === "auto_approved") return "已自动批准";
  if (status === "approved") return "已批准";
  if (status === "rejected") return "已拒绝";
  return "等待审批";
}

function getBooleanField(value: unknown, field: string) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>)[field] === "boolean" ? Boolean((value as Record<string, unknown>)[field]) : null;
}

function getDiscoveryToolLabel(toolName: string) {
  if (toolName === "searchFilesByName") return "文件名发现";
  if (toolName === "listFiles") return "目录发现";
  if (toolName === "listCodeDefinitionNames") return "结构发现";
  if (toolName === "searchCodeRegex") return "正则搜索";
  if (toolName === "searchCode") return "文本搜索";
  if (toolName === "readFileChunk" || toolName === "readFileRange") return "分块读取";
  if (toolName === "readFile") return "首块读取";
  return "";
}

function formatLineRange(value: unknown) {
  const startLine = getNumberField(value, "startLine");
  const endLine = getNumberField(value, "endLine");

  if (startLine === null || endLine === null) return "";

  return `${startLine}-${endLine} 行`;
}

function getAgentObservationChips(step: AgentStep) {
  const chips: string[] = [];

  if (step.type === "strategy") {
    if (step.toolName) chips.push(`工具：${step.toolName}`);
    if (step.repeatCount !== undefined) chips.push(`重复 ${step.repeatCount} 次`);
    if (step.currentStep !== undefined && step.maxSteps !== undefined) chips.push(`轮次 ${step.currentStep}/${step.maxSteps}`);
    if (step.facts?.length) chips.push(`${step.facts.length} 条已确认事实`);
    return chips;
  }

  if (step.type === "message" && step.content.includes("Tool budget warning")) {
    return ["预算即将耗尽"];
  }

  if (step.type === "error" && step.message.includes("Tool budget limit reached")) {
    return ["预算限制停止"];
  }

  if (step.type === "completion_rejected") {
    return [`拒绝代码：${step.rejectionCode}`, step.shouldRecover ? "可自动恢复" : "需要外部操作"];
  }

  if (step.type === "tool_blocked") return [`工具：${step.toolName}`, "策略门禁"];

  if (step.type !== "tool_result") return [];

  const discoveryLabel = getDiscoveryToolLabel(step.toolName);
  const cached = getBooleanField(step.output, "cached");
  const resultCount = getNumberField(step.output, "resultCount");
  const fileCount = getNumberField(step.output, "fileCount");
  const definitionCount = getNumberField(step.output, "definitionCount");
  const linesRead = getNumberField(step.output, "linesRead");
  const hasMoreAfter = getBooleanField(step.output, "hasMoreAfter");
  const lineRange = formatLineRange(step.output);

  // 观测信息只取工具摘要中的稳定字段，避免把完整文件内容再次渲染到步骤面板。
  if (discoveryLabel) chips.push(discoveryLabel);
  if (cached === true) chips.push("命中缓存");
  if (resultCount !== null) chips.push(`${resultCount} 个结果`);
  if (fileCount !== null) chips.push(`${fileCount} 个文件`);
  if (definitionCount !== null) chips.push(`${definitionCount} 个定义`);
  if (lineRange) chips.push(lineRange);
  if (linesRead !== null) chips.push(`读取 ${linesRead} 行`);
  if (hasMoreAfter === true) chips.push("仍有后续 chunk");

  return chips;
}

function getRiskText(riskLevel: ApprovalStep["riskLevel"]) {
  if (riskLevel === "high") return "高风险";
  if (riskLevel === "medium") return "中风险";
  return "低风险";
}

function getApprovalOperationName(step: ApprovalStep) {
  const title = typeof step.title === "string" ? step.title.trim() : "";
  if (title) return title;

  const actionNames: Record<ApprovalStep["actionType"], string> = {
    inspect_project: "检查项目",
    search_code: "搜索代码",
    read_file: "读取文件",
    edit_files: "编辑文件",
    run_command: "运行命令",
    apply_patch: "应用补丁",
    write_file: "写入文件",
    delete_file: "删除文件",
    ask_user: "请求用户确认",
    tool_call: "调用工具"
  };

  // 兼容历史审批记录缺少标题的情况，至少展示稳定的操作类型或工具名称。
  const toolName = isRecord(step.details) && typeof step.details.toolName === "string" ? step.details.toolName.trim() : "";
  return toolName || actionNames[step.actionType] || "执行智能体操作";
}

function getApprovalOperationDescription(step: ApprovalStep) {
  const summary = typeof step.summary === "string" ? step.summary.trim() : "";
  if (summary) return summary;

  const target = step.command || step.targets?.filter(Boolean).join("、") || "";
  return target ? `准备对 ${target} 执行此操作，批准后智能体将继续。` : "批准后智能体将执行此操作并继续当前任务。";
}

function getCommandStatusText(step: Extract<AgentStep, { type: "command" }>) {
  if (step.status === "blocked") return "Blocked";
  if (step.status === "cancelled") return "Cancelled";
  if (step.status === "running") return "Running";
  if (step.status === "success") return "Succeeded";
  if (step.status === "failed") return "Failed";
  return "Suggested";
}

function getAgentStepView(step: AgentStep): { label: string; title: string; detail: string } {
  if (step.type === "message") {
    return { label: "Message", title: step.content, detail: "" };
  }

  if (step.type === "strategy") {
    const views = {
      repeated_tool_warning: { label: "警告", title: "检测到重复工具调用" },
      repeated_tool_blocked: { label: "已阻止", title: "重复工具调用已阻止" },
      negative_evidence: { label: "已确认", title: "已确认目标文件或代码不存在" },
      create_intent: { label: "创建计划", title: "已识别新文件创建意图" },
      create_intent_search_blocked: { label: "已收敛", title: "已阻止对计划新建文件的重复搜索" },
      no_progress_recovery: { label: "切换策略", title: "连续无进展，正在切换策略" },
      completion_recovery: { label: "继续交付", title: "完成证据不足，继续执行" },
      budget_convergence: { label: "收敛", title: "进入预算收敛阶段" },
      no_progress_stop: { label: "已停止", title: "因连续无进展停止" },
      budget_stop: { label: "已停止", title: "因模型步骤预算停止" }
    } as const;
    const view = views[step.event];
    return { ...view, detail: step.message };
  }

  if (step.type === "approval_request") {
    const targetText = step.command || step.targets?.join(", ") || "";
    return {
      label: "Approval",
      title: step.title,
      detail: [getRiskText(step.riskLevel), getApprovalStatusText(step.status), targetText].filter(Boolean).join(" / ")
    };
  }

  if (step.type === "tool_call") {
    const purpose = getStringField(step.input, "purpose");

    if (purpose) {
      return { label: "调用目的", title: purpose, detail: getStringField(step.input, "toolDescription") || step.toolName };
    }

    if (step.toolName === "searchCode") {
      return { label: "Search", title: `Searching ${getStringField(step.input, "query") || summarizeUnknown(step.input)}`, detail: "" };
    }

    if (step.toolName === "searchFilesByName") {
      return { label: "Discover", title: `Finding files ${getStringField(step.input, "query") || summarizeUnknown(step.input)}`, detail: getStringField(step.input, "path") };
    }

    if (step.toolName === "listFiles") {
      return { label: "Discover", title: `Listing ${getStringField(step.input, "path") || "."}`, detail: "" };
    }

    if (step.toolName === "listCodeDefinitionNames") {
      return { label: "Discover", title: `Inspecting definitions in ${getStringField(step.input, "path") || "."}`, detail: "" };
    }

    if (step.toolName === "searchCodeRegex") {
      return { label: "Regex", title: `Searching ${getStringField(step.input, "regex") || summarizeUnknown(step.input)}`, detail: getStringField(step.input, "filePattern") };
    }

    if (step.toolName === "readFile") {
      return { label: "Read", title: `Reading ${getStringField(step.input, "filePath") || summarizeUnknown(step.input)}`, detail: "" };
    }

    if (step.toolName === "readFileChunk" || step.toolName === "readFileRange") {
      const filePath = getStringField(step.input, "filePath") || summarizeUnknown(step.input);
      const startLine = getNumberField(step.input, "startLine");
      const endLine = getNumberField(step.input, "endLine");
      const range = startLine !== null && endLine !== null ? `${startLine}-${endLine}` : "";
      return { label: "Chunk", title: `Reading ${filePath}`, detail: range };
    }

    return { label: "调用目的", title: `调用 ${step.toolName} 以推进当前任务`, detail: summarizeUnknown(step.input) };
  }

  if (step.type === "tool_result") {
    if (step.toolName === "searchCode") {
      const count = getNumberField(step.output, "resultCount");
      return { label: "Result", title: `Search completed with ${count ?? 0} result(s)`, detail: getStringField(step.output, "query") };
    }

    if (step.toolName === "searchFilesByName") {
      const count = getNumberField(step.output, "resultCount");
      return { label: "Result", title: `File discovery completed with ${count ?? 0} match(es)`, detail: getStringField(step.output, "query") };
    }

    if (step.toolName === "listFiles") {
      const count = getNumberField(step.output, "resultCount");
      return { label: "Result", title: `Listed ${count ?? 0} path(s)`, detail: getStringField(step.output, "path") || "." };
    }

    if (step.toolName === "listCodeDefinitionNames") {
      const fileCount = getNumberField(step.output, "fileCount");
      const definitionCount = getNumberField(step.output, "definitionCount");
      return { label: "Result", title: `Found ${definitionCount ?? 0} definition(s)`, detail: `${fileCount ?? 0} file(s)` };
    }

    if (step.toolName === "searchCodeRegex") {
      const count = getNumberField(step.output, "resultCount");
      return { label: "Result", title: `Regex search completed with ${count ?? 0} result(s)`, detail: getStringField(step.output, "regex") };
    }

    if (step.toolName === "readFile" || step.toolName === "readFileChunk" || step.toolName === "readFileRange") {
      const filePath = getStringField(step.output, "filePath");
      const linesRead = getNumberField(step.output, "linesRead");
      const lineRange = formatLineRange(step.output);
      return { label: "Result", title: `Read ${filePath || summarizeUnknown(step.output)}`, detail: [lineRange, linesRead === null ? "" : `${linesRead} line(s)`].filter(Boolean).join(" / ") };
    }

    return { label: "Result", title: `Received ${step.toolName} result`, detail: summarizeUnknown(step.output) };
  }

  if (step.type === "completion_rejected") {
    return {
      // 完成拒绝不是可审批实体；真实审批按钮只属于 approval_request。
      label: step.completionStatus === "awaiting_approval" ? "等待处理" : "完成条件未满足",
      title: step.message,
      detail: step.suggestedAction ? `下一步：${step.suggestedAction}` : ""
    };
  }

  if (step.type === "tool_blocked") {
    return { label: "工具已阻止", title: step.message, detail: step.toolName };
  }

  if (step.type === "workflow_decision") {
    return {
      label: step.decision === "allowed" ? "门禁放行" : "门禁阻塞",
      title: `${step.toolName} · ${step.workflowType}`,
      detail: step.reason || `${step.references.length} 项引用事实`
    };
  }

  if (step.type === "edit") {
    return { label: "Edit", title: `Generated changes for ${step.files.length} file(s)`, detail: step.files.join(", ") };
  }

  if (step.type === "command") {
    const pieces = [step.result ? `exit ${step.result.exitCode ?? "null"}` : step.policy?.level || "", step.result?.detectedUrl ? `URL ${step.result.detectedUrl}` : ""].filter(Boolean);
    return { label: "Command", title: `${getCommandStatusText(step)}: ${step.command}`, detail: pieces.join(" / ") };
  }

  if (step.type === "checkpoint") {
    const sourceTool = step.source?.toolName || "workspace change";
    return { label: "Checkpoint", title: `Created checkpoint ${step.checkpointId}`, detail: `${sourceTool} / ${step.files.length} file(s)` };
  }

  return { label: "Error", title: "Tool failed", detail: step.message };
}

function CheckpointCard({
  disabled = false,
  step,
  onRollbackCheckpoint
}: {
  disabled?: boolean;
  step: Extract<AgentStep, { type: "checkpoint" }>;
  onRollbackCheckpoint?: (checkpointId: string) => void;
}) {
  return (
    <article className="agent-checkpoint-card">
      <strong>Checkpoint {step.checkpointId}</strong>
      <p>{step.source?.toolName ? `Created by ${step.source.toolName}.` : "Created after workspace changes."}</p>
      {step.files.length > 0 && (
        <ul>
          {step.files.slice(0, 5).map((filePath) => (
            <li key={filePath}>
              <code>{filePath}</code>
            </li>
          ))}
        </ul>
      )}
      {step.files.length > 5 && <small>{step.files.length - 5} more file(s)</small>}
      {onRollbackCheckpoint && (
        <div className="agent-approval-actions">
          <button type="button" className="secondary" disabled={disabled} onClick={() => onRollbackCheckpoint(step.checkpointId)}>
            Roll back
          </button>
        </div>
      )}
    </article>
  );
}

function ApprovalRequestCard({
  disabled = false,
  pending = false,
  step,
  onDecideApproval
}: {
  disabled?: boolean;
  pending?: boolean;
  step: ApprovalStep;
  onDecideApproval?: (step: ApprovalStep, decision: "approved" | "rejected") => Promise<void>;
}) {
  const targets = step.command ? [step.command] : step.targets || [];
  const operationName = getApprovalOperationName(step);
  const operationDescription = getApprovalOperationDescription(step);
  // 只有 runtime 绑定了 pendingToolCall 的审批才能批准/拒绝，避免普通 diff 预览误显示为工具审批。
  const canDecide = step.status === "pending" && isRuntimeApprovalStep(step) && Boolean(onDecideApproval);
  const processing = pending && canDecide;

  return (
    <article className={`agent-approval-card risk-${step.riskLevel} status-${step.status}`}>
      <div className="agent-approval-card-header">
        <span>{getRiskText(step.riskLevel)}</span>
        <small>{processing ? "处理中..." : getApprovalStatusText(step.status)}</small>
      </div>
      <dl className="agent-approval-operation">
        <div>
          <dt>操作名称</dt>
          <dd>{operationName}</dd>
        </div>
        <div>
          <dt>操作描述</dt>
          <dd>{operationDescription}</dd>
        </div>
      </dl>
      {targets.length > 0 && (
        <ul>
          {targets.slice(0, 5).map((target) => (
            <li key={target}>
              <code>{target}</code>
            </li>
          ))}
        </ul>
      )}
      {targets.length > 5 && <small>{targets.length - 5} more item(s)</small>}
      {canDecide && (
        <div className="agent-approval-actions">
          <button type="button" className="secondary" disabled={disabled || pending} onClick={() => void onDecideApproval?.(step, "rejected")}>
            {processing ? "处理中..." : "拒绝"}
          </button>
          <button type="button" disabled={disabled || pending} onClick={() => void onDecideApproval?.(step, "approved")}>
            {processing ? "处理中..." : "批准"}
          </button>
        </div>
      )}
    </article>
  );
}

function AgentStepDetailBlock({ step }: { step: AgentStep }) {
  const detail = <pre>{formatAgentStepDetail(step)}</pre>;

  if (step.type !== "approval_request" || step.status !== "pending") {
    return detail;
  }

  return (
    <details className="agent-step-raw-details">
      <summary>查看工具调用详细信息</summary>
      {/* 人工审批时默认隐藏原始调用参数，避免审批卡片一展开就暴露过多底层细节。 */}
      {detail}
    </details>
  );
}

function AgentStepObservation({ step }: { step: AgentStep }) {
  const chips = getAgentObservationChips(step);

  if (!chips.length) return null;

  return (
    <div className="agent-step-observation" aria-label="Agent 工具观测信息">
      {chips.map((chip) => (
        <span key={chip}>{chip}</span>
      ))}
    </div>
  );
}

function CompletionRejectionCard({ step }: { step: Extract<AgentStep, { type: "completion_rejected" }> }) {
  return (
    <article className="agent-completion-rejection" role="status">
      <div>
        <strong>拒绝原因</strong>
        <code>{step.rejectionCode}</code>
      </div>
      <p>{step.message}</p>
      {step.suggestedAction && (
        <div>
          <strong>建议下一步</strong>
          <p>{step.suggestedAction}</p>
        </div>
      )}
    </article>
  );
}

function WorkflowDecisionCard({ step }: { step: Extract<AgentStep, { type: "workflow_decision" }> }) {
  return (
    <article className={`agent-workflow-decision decision-${step.decision}`}>
      {step.plannedFiles.length > 0 && (
        <div>
          <strong>计划创建</strong>
          {step.plannedFiles.map((filePath) => <code key={filePath}>{filePath}</code>)}
        </div>
      )}
      {step.references.length > 0 && (
        <div>
          <strong>引用状态</strong>
          <ul>
            {step.references.map((reference) => (
              <li key={`${reference.target}:${reference.resolvedPath || ""}`}>
                <span className={`reference-status status-${reference.status}`}>
                  {reference.status === "planned_create" ? "补丁后可解析" : reference.blocking ? "阻塞引用" : "已解析"}
                </span>
                <code>{reference.target.replace(/^[^:]+:/, "")}</code>
                <small>{reference.reason}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      {step.decision === "blocked" && (
        <div className="workflow-block-facts">
          <strong>阻塞原因</strong>
          <p>{step.reason || "工作流前置条件尚未满足。"}</p>
          <span>推荐恢复工具：{step.recommendedTools.join("、") || "无自动恢复工具"}</span>
          <span>{step.requiresUserAction ? "需要用户操作" : "可由 Agent 自动恢复"}</span>
        </div>
      )}
    </article>
  );
}

type Props = {
  disabled?: boolean;
  inline?: boolean;
  steps: AgentStep[];
  title?: string;
  onDecideApproval?: (step: ApprovalStep, decision: "approved" | "rejected") => Promise<void>;
  onRollbackCheckpoint?: (checkpointId: string) => void;
};

export default function AgentStepsPanel({ disabled = false, inline = false, steps, title = "Agent Steps", onDecideApproval, onRollbackCheckpoint }: Props) {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  if (!steps.length) return null;

  async function decideApproval(step: ApprovalStep, decision: "approved" | "rejected") {
    if (!onDecideApproval) return;

    setPendingActionId(step.actionId);

    try {
      await onDecideApproval(step, decision);
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <section className={inline ? "agent-steps agent-steps-inline" : "agent-steps"} aria-label={title}>
      {!inline && <strong>{title}</strong>}
      <ol>
        {steps.map((step) => {
          const view = getAgentStepView(step);
          const showApprovalCard = step.type === "approval_request" && (step.status !== "pending" || isRuntimeApprovalStep(step));

          return (
            <li key={step.id} className={`agent-step-${step.type}${step.type === "strategy" ? ` agent-step-strategy-${step.event}` : ""}${step.type === "completion_rejected" ? ` status-${step.completionStatus}` : ""}${step.type === "approval_request" || step.type === "command" ? ` status-${step.status ?? "suggested"}` : ""}`}>
              <span>{view.label}</span>
              <details open={(step.type === "approval_request" && step.status === "pending") || step.type === "completion_rejected"}>
                <summary>
                  <b>{view.title}</b>
                  {view.detail && <small>{view.detail}</small>}
                </summary>
                <AgentStepObservation step={step} />
                {step.type === "completion_rejected" && <CompletionRejectionCard step={step} />}
                {step.type === "workflow_decision" && <WorkflowDecisionCard step={step} />}
                {step.type === "approval_request" && showApprovalCard && <ApprovalRequestCard disabled={disabled} pending={pendingActionId === step.actionId} step={step} onDecideApproval={decideApproval} />}
                {step.type === "checkpoint" && <CheckpointCard disabled={disabled} step={step} onRollbackCheckpoint={onRollbackCheckpoint} />}
                <AgentStepDetailBlock step={step} />
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
