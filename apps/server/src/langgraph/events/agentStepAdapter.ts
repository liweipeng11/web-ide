import crypto from "node:crypto";
import type { OrchestrationAgentId } from "../../agents/main/orchestrationContracts.js";
import type { AgentStep } from "../../types.js";

export type GraphLifecycleEvent = {
  runId: string;
  sequence: number;
  type: "node" | "task" | "update" | "interrupt" | "final";
  phase?: "started" | "completed";
  node?: string;
  taskId?: string;
  status?: "success" | "failed" | "blocked";
  summary?: string;
  actionId?: string;
  actionTitle?: string;
};

function stepIdentity(event: GraphLifecycleEvent): { id: string; createdAt: number } {
  const digest = crypto.createHash("sha256")
    .update([event.runId, event.sequence, event.type, event.node, event.taskId].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return { id: `graph-step:${digest}`, createdAt: Date.now() };
}

function agentForNode(node: string | undefined): OrchestrationAgentId {
  if (node?.includes("planner")) return "planner";
  if (node?.includes("explorer")) return "explorer";
  if (node?.includes("developer")) return "developer";
  if (node?.includes("tester") || node?.includes("validation")) return "tester";
  return "main";
}

function safeSummary(value: string | undefined, fallback: string): string {
  const summary = value?.replace(/[\r\n]+/g, " ").trim() || fallback;
  // Graph 事件只允许短摘要进入前端，防止源码、Prompt 或命令完整输出混入步骤流。
  return summary.slice(0, 500);
}

/** 将 Graph 事件映射到已有 AgentStep 联合类型，前端无需理解节点名称或 Graph 内部状态。 */
export function graphEventToAgentStep(event: GraphLifecycleEvent): AgentStep {
  const identity = stepIdentity(event);
  if (event.type === "interrupt") {
    if (!event.actionId) throw new Error("Graph interrupt 事件缺少 actionId。");
    return {
      ...identity,
      type: "approval_request",
      actionId: event.actionId,
      actionType: "ask_user",
      title: safeSummary(event.actionTitle, "需要用户确认"),
      summary: safeSummary(event.summary, "Graph 已暂停，等待用户确认。"),
      riskLevel: "low",
      status: "pending"
    };
  }
  if (event.type === "final" || event.type === "update") {
    return {
      ...identity,
      type: "message",
      content: safeSummary(event.summary, event.type === "final" ? "Graph 执行完成。" : "Graph 状态已更新。")
    };
  }
  return {
    ...identity,
    type: "orchestration",
    agent: agentForNode(event.node),
    phase: event.phase ?? (event.status ? "completed" : "started"),
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.summary ? { summary: safeSummary(event.summary, "") } : {})
  };
}

