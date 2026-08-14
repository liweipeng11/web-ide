import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { TaskSession } from "../types.js";

export type ApprovedPipelineGraphResult<T> =
  | { outcome: "not_applicable"; reason: string }
  | { outcome: "executed"; value: T };

type ApprovedPipelineExecutor<T> = (session: TaskSession) => Promise<T>;

const ApprovedPipelineState = Annotation.Root({
  session: Annotation<TaskSession>,
  applicable: Annotation<boolean>,
  reason: Annotation<string | undefined>,
  value: Annotation<unknown>
});

function eligibility(session: TaskSession): { applicable: true } | { applicable: false; reason: string } {
  if (session.agentMode !== "act") return { applicable: false, reason: "任务不处于 act 模式。" };
  if (session.planApproval?.status !== "approved") return { applicable: false, reason: "任务计划尚未批准。" };
  if (!session.runtimePlan) return { applicable: false, reason: "任务没有 Runtime Plan。" };
  return { applicable: true };
}

/**
 * 批准后任务的 LangGraph 控制面。Graph 只决定流程推进，TaskSession 仍是业务状态真相来源。
 */
export async function runApprovedPipelineGraph<T>(
  session: TaskSession,
  execute: ApprovedPipelineExecutor<T>
): Promise<ApprovedPipelineGraphResult<T>> {
  const graph = new StateGraph(ApprovedPipelineState)
    .addNode("check_approval", async (state) => eligibility(state.session))
    .addNode("execute_approved_plan", async (state) => ({ value: await execute(state.session) }))
    .addConditionalEdges("check_approval", (state) => state.applicable ? "execute" : "stop", {
      execute: "execute_approved_plan",
      stop: END
    })
    .addEdge(START, "check_approval")
    .addEdge("execute_approved_plan", END)
    .compile();

  const result = await graph.invoke({ session });
  if (!result.applicable) {
    return { outcome: "not_applicable", reason: result.reason ?? "任务不满足执行条件。" };
  }
  return { outcome: "executed", value: result.value as T };
}
