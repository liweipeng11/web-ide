import type { AgentTaskPacket, Plan } from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import type { PlannerCreatePlanInput, PlannerReplanInput, PlannerResult } from "./contracts.js";
import { PlannerAgent, type PlannerAgentResult } from "./plannerAgent.js";
import { EXPLORER_TOOL_NAMES, explorerRuntimeTools } from "../explorer/explorerTools.js";
import { config } from "../../config.js";

function planningTask(goal: string, readScope: string[], context: AgentTaskPacket["context"]): { plan: Plan; task: AgentTaskPacket } {
  const task = {
    id: "PLANNER-READ-CONTEXT",
    type: "explore" as const,
    goal: `为规划补充仓库上下文：${goal}`,
    dependencies: [],
    requiredCapabilities: ["planning", "exploration"],
    readScope: [...readScope],
    writeScope: [],
    acceptanceCriteria: ["生成有效计划，或给出仍缺失的上下文"],
    status: "pending" as const
  };
  return {
    plan: { version: 1, goal, assumptions: [], tasks: [task], completionCriteria: [...task.acceptanceCriteria] },
    task: {
      taskId: task.id,
      goal: task.goal,
      context,
      constraints: [],
      acceptanceCriteria: [...task.acceptanceCriteria],
      readScope: [...readScope],
      writeScope: [],
      allowedTools: [...EXPLORER_TOOL_NAMES]
    }
  };
}

/** Planner 的工具执行边界：仅复用四个受路径校验的 Explorer 只读工具。 */
export class PlannerAgentRuntime {
  constructor(private readonly agent: PlannerAgent = new PlannerAgent()) {}

  async createPlan(input: PlannerCreatePlanInput): Promise<PlannerResult> {
    return this.execute(input.goal, input.readScope, { phase: "create", request: input });
  }

  async replan(input: PlannerReplanInput): Promise<PlannerResult> {
    return this.execute(input.oldPlan.goal, input.readScope, { phase: "replan", request: input });
  }

  private async execute(goal: string, readScope: string[], context: AgentTaskPacket["context"]): Promise<PlannerResult> {
    const { plan, task } = planningTask(goal, readScope, context);
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: new ToolRegistry(explorerRuntimeTools),
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: [...EXPLORER_TOOL_NAMES] }]),
      state: new StateManager(createAgentState(goal, plan)),
      executionPolicy: config.agentRuntimeStabilityPolicy
    });
    const execution = await kernel.execute(this.agent.id, task);
    const result = execution.result as Partial<PlannerAgentResult>;
    if (!result.planning) {
      // Runtime 已将工具权限或契约异常转换为安全的 AgentResult；继续向上游保留失败状态，
      // 避免因为缺少扩展字段而把原始异常抛回 UI。
      return {
        status: "failed",
        reason: "model_error",
        blockers: result.blockers?.length ? result.blockers : ["Planner Runtime 未返回规划结果。"]
      };
    }
    return result.planning;
  }
}
