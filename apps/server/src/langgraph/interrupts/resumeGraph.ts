import { Command } from "@langchain/langgraph";
import type { createApprovalInterruptGraph, GraphApprovalDecision, ApprovalGraphState } from "./approvalInterrupt.js";
import { approvalGraphConfig } from "./approvalInterrupt.js";

type ApprovalGraph = ReturnType<typeof createApprovalInterruptGraph>;
const resumeQueues = new Map<string, Promise<unknown>>();

export type ApprovalResumeResult = {
  state: ApprovalGraphState;
  replayed: boolean;
};

/**
 * 同一 action 的 resume 在进程内串行化，并先检查持久化终态。
 * 服务重启后仍会读取 checkpoint，因此重复请求不会再次推进 record_decision 节点。
 */
export async function resumeApprovalGraph(
  graph: ApprovalGraph,
  taskSessionId: string,
  decision: GraphApprovalDecision
): Promise<ApprovalResumeResult> {
  const config = approvalGraphConfig(taskSessionId);
  const key = String(config.configurable.thread_id);
  const previous = resumeQueues.get(key) ?? Promise.resolve();
  let result!: ApprovalResumeResult;
  const next = previous.catch(() => undefined).then(async () => {
    const snapshot = await graph.getState(config);
    const current = snapshot.values as Partial<ApprovalGraphState>;
    if (current.decisionApplied && (current.status === "approved" || current.status === "rejected")) {
      result = { state: current as ApprovalGraphState, replayed: true };
      return;
    }
    const state = await graph.invoke(new Command({ resume: decision }), config) as ApprovalGraphState;
    result = { state, replayed: false };
  });
  resumeQueues.set(key, next);
  try {
    await next;
    return result;
  } finally {
    if (resumeQueues.get(key) === next) resumeQueues.delete(key);
  }
}

