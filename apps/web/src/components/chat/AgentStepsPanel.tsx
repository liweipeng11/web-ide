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
  } else if (step.type === "tool_call") {
    detail = { type: step.type, toolName: step.toolName, input: step.input };
  } else if (step.type === "tool_result") {
    detail = { type: step.type, toolName: step.toolName, output: step.output };
  } else if (step.type === "edit") {
    detail = { type: step.type, files: step.files };
  } else if (step.type === "command") {
    detail = { type: step.type, command: step.command, status: step.status, policy: step.policy, result: sanitizedResult(step.result) };
  } else if (step.type === "checkpoint") {
    detail = { type: step.type, checkpointId: step.checkpointId, files: step.files, source: step.source };
  } else if (step.type === "message") {
    detail = { type: step.type, content: step.content };
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

  if (step.type === "message" && step.content.includes("Tool budget warning")) {
    return ["预算即将耗尽"];
  }

  if (step.type === "error" && step.message.includes("Tool budget limit reached")) {
    return ["预算限制停止"];
  }

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
      return { label: "Tool", title: purpose, detail: getStringField(step.input, "toolDescription") || step.toolName };
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

    return { label: "Tool", title: `Calling ${step.toolName}`, detail: summarizeUnknown(step.input) };
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
  // 只有 runtime 绑定了 pendingToolCall 的审批才能批准/拒绝，避免普通 diff 预览误显示为工具审批。
  const canDecide = step.status === "pending" && isRuntimeApprovalStep(step) && Boolean(onDecideApproval);
  const processing = pending && canDecide;

  return (
    <article className={`agent-approval-card risk-${step.riskLevel} status-${step.status}`}>
      <div className="agent-approval-card-header">
        <span>{getRiskText(step.riskLevel)}</span>
        <small>{processing ? "处理中..." : getApprovalStatusText(step.status)}</small>
      </div>
      <strong>{step.title}</strong>
      <p>{step.summary}</p>
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
            <li key={step.id} className={`agent-step-${step.type}`}>
              <span>{view.label}</span>
              <details open={step.type === "approval_request" && step.status === "pending"}>
                <summary>
                  <b>{view.title}</b>
                  {view.detail && <small>{view.detail}</small>}
                </summary>
                <AgentStepObservation step={step} />
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
