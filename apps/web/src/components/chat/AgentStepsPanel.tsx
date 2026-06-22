import type { AgentStep } from "../../api";
import { getNumberField, getStringField, summarizeUnknown } from "./chatUtils";

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

  if (step.type === "tool_call") {
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

function getCommandStatusText(step: Extract<AgentStep, { type: "command" }>) {
  if (step.status === "blocked") return "已拒绝";
  if (step.status === "cancelled") return "已取消";
  if (step.status === "running") return "执行中";
  if (step.status === "success") return "执行成功";
  if (step.status === "failed") return "执行失败";
  return "建议运行";
}

function getAgentStepView(step: AgentStep): { label: string; title: string; detail: string } {
  if (step.type === "message") {
    return { label: "消息", title: step.content, detail: "" };
  }

  if (step.type === "tool_call") {
    const purpose = getStringField(step.input, "purpose");

    if (purpose) {
      return { label: "Tool", title: purpose, detail: getStringField(step.input, "toolDescription") || step.toolName };
    }

    if (step.toolName === "searchCode") {
      return { label: "搜索", title: `正在搜索 ${getStringField(step.input, "query") || summarizeUnknown(step.input)}`, detail: "" };
    }

    if (step.toolName === "readFile") {
      return { label: "读取", title: `正在读取 ${getStringField(step.input, "filePath") || summarizeUnknown(step.input)}`, detail: "" };
    }

    return { label: "工具", title: `调用工具 ${step.toolName}`, detail: summarizeUnknown(step.input) };
  }

  if (step.type === "tool_result") {
    if (step.toolName === "searchCode") {
      const count = getNumberField(step.output, "resultCount");
      return { label: "结果", title: `搜索完成，找到 ${count ?? 0} 条结果`, detail: getStringField(step.output, "query") };
    }

    if (step.toolName === "readFile") {
      const filePath = getStringField(step.output, "filePath");
      const linesRead = getNumberField(step.output, "linesRead");
      return { label: "结果", title: `已读取 ${filePath || summarizeUnknown(step.output)}`, detail: linesRead === null ? "" : `${linesRead} 行` };
    }

    return { label: "结果", title: `收到 ${step.toolName} 的结果`, detail: summarizeUnknown(step.output) };
  }

  if (step.type === "edit") {
    return { label: "编辑", title: `已生成 ${step.files.length} 个文件的修改`, detail: step.files.join(", ") };
  }

  if (step.type === "command") {
    const pieces = [step.result ? `exit ${step.result.exitCode ?? "null"}` : step.policy?.level || "", step.result?.detectedUrl ? `URL ${step.result.detectedUrl}` : ""].filter(Boolean);
    return { label: "命令", title: `${getCommandStatusText(step)}：${step.command}`, detail: pieces.join(" · ") };
  }

  return { label: "错误", title: "工具执行失败", detail: step.message };
}

type Props = {
  inline?: boolean;
  steps: AgentStep[];
  title?: string;
};

export default function AgentStepsPanel({ inline = false, steps, title = "Agent Steps" }: Props) {
  if (!steps.length) return null;

  return (
    <section className={inline ? "agent-steps agent-steps-inline" : "agent-steps"} aria-label={title}>
      {!inline && <strong>{title}</strong>}
      <ol>
        {steps.map((step) => {
          const view = getAgentStepView(step);

          return (
            <li key={step.id} className={`agent-step-${step.type}`}>
              <span>{view.label}</span>
              <details>
                <summary>
                  <b>{view.title}</b>
                  {view.detail && <small>{view.detail}</small>}
                </summary>
                <pre>{formatAgentStepDetail(step)}</pre>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
