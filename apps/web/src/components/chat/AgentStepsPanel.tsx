import { useState } from "react";
import type { AgentStep } from "../../api";
import { getNumberField, getStringField, summarizeUnknown } from "./chatUtils";

type ApprovalStep = Extract<AgentStep, { type: "approval_request" }>;

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
  if (status === "auto_approved") return "Auto approved";
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Awaiting approval";
}

function getRiskText(riskLevel: ApprovalStep["riskLevel"]) {
  if (riskLevel === "high") return "High risk";
  if (riskLevel === "medium") return "Medium risk";
  return "Low risk";
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

    if (step.toolName === "readFile") {
      return { label: "Read", title: `Reading ${getStringField(step.input, "filePath") || summarizeUnknown(step.input)}`, detail: "" };
    }

    return { label: "Tool", title: `Calling ${step.toolName}`, detail: summarizeUnknown(step.input) };
  }

  if (step.type === "tool_result") {
    if (step.toolName === "searchCode") {
      const count = getNumberField(step.output, "resultCount");
      return { label: "Result", title: `Search completed with ${count ?? 0} result(s)`, detail: getStringField(step.output, "query") };
    }

    if (step.toolName === "readFile") {
      const filePath = getStringField(step.output, "filePath");
      const linesRead = getNumberField(step.output, "linesRead");
      return { label: "Result", title: `Read ${filePath || summarizeUnknown(step.output)}`, detail: linesRead === null ? "" : `${linesRead} line(s)` };
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

  return { label: "Error", title: "Tool failed", detail: step.message };
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
  const canDecide = step.status === "pending" && Boolean(onDecideApproval);

  return (
    <article className={`agent-approval-card risk-${step.riskLevel} status-${step.status}`}>
      <div className="agent-approval-card-header">
        <span>{getRiskText(step.riskLevel)}</span>
        <small>{getApprovalStatusText(step.status)}</small>
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
            Reject
          </button>
          <button type="button" disabled={disabled || pending} onClick={() => void onDecideApproval?.(step, "approved")}>
            Approve
          </button>
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
};

export default function AgentStepsPanel({ disabled = false, inline = false, steps, title = "Agent Steps", onDecideApproval }: Props) {
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

          return (
            <li key={step.id} className={`agent-step-${step.type}`}>
              <span>{view.label}</span>
              <details open={step.type === "approval_request" && step.status === "pending"}>
                <summary>
                  <b>{view.title}</b>
                  {view.detail && <small>{view.detail}</small>}
                </summary>
                {step.type === "approval_request" && <ApprovalRequestCard disabled={disabled} pending={pendingActionId === step.actionId} step={step} onDecideApproval={decideApproval} />}
                <pre>{formatAgentStepDetail(step)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
