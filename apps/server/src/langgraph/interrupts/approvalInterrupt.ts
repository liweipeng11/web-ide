import { Annotation, END, interrupt, START, StateGraph, type BaseCheckpointSaver } from "@langchain/langgraph";
import { graphApprovalActionId, graphThreadIdForTask } from "../persistence/threadIdentity.js";

export type GraphApprovalDecision = "approved" | "rejected";
export type GraphApprovalStatus = "pending" | GraphApprovalDecision;

const ApprovalState = Annotation.Root({
  taskSessionId: Annotation<string>,
  actionId: Annotation<string>,
  title: Annotation<string>,
  summary: Annotation<string>,
  status: Annotation<GraphApprovalStatus>,
  decisionApplied: Annotation<boolean>
});

export type ApprovalGraphState = typeof ApprovalState.State;

export type ApprovalGraphOptions = {
  checkpointer: BaseCheckpointSaver;
  onDecision?: (state: Readonly<ApprovalGraphState>) => Promise<void> | void;
};

/** 阶段 4 的审批图只记录决定，不执行 Patch、文件写入或命令。 */
export function createApprovalInterruptGraph(options: ApprovalGraphOptions) {
  return new StateGraph(ApprovalState)
    .addNode("approval_interrupt", async (state) => {
      if (state.status !== "pending") return {};
      const decision = interrupt({
        actionId: state.actionId,
        title: state.title,
        summary: state.summary,
        actionType: "ask_user"
      });
      if (decision !== "approved" && decision !== "rejected") throw new Error("Graph 审批决定无效。");
      return { status: decision };
    })
    .addNode("record_decision", async (state) => {
      if (state.decisionApplied) return {};
      await options.onDecision?.(state);
      return { decisionApplied: true };
    })
    .addEdge(START, "approval_interrupt")
    .addEdge("approval_interrupt", "record_decision")
    .addEdge("record_decision", END)
    .compile({ checkpointer: options.checkpointer });
}

export function approvalGraphConfig(taskSessionId: string) {
  return {
    configurable: {
      thread_id: graphThreadIdForTask(taskSessionId, "approval"),
      // checkpoint_ns 由 LangGraph 为子图内部管理；业务图隔离体现在稳定 thread ID 中。
      checkpoint_ns: ""
    }
  };
}

export function approvalGraphInput(input: { taskSessionId: string; actionKey: string; title: string; summary: string }): ApprovalGraphState {
  return {
    taskSessionId: input.taskSessionId,
    actionId: graphApprovalActionId(input.taskSessionId, input.actionKey),
    title: input.title.trim(),
    summary: input.summary.trim(),
    status: "pending",
    decisionApplied: false
  };
}
