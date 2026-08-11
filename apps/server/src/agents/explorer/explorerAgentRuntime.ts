import type { AgentResult, AgentTaskPacket, Plan, RuntimeExecutionDiagnostics, Task } from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager, validatePlan } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import { runtimeError } from "../../runtime/errors.js";
import type { ExplorerAgentResult, ExplorerResult } from "./contracts.js";
import { ExplorerAgent } from "./explorerAgent.js";
import { EXPLORER_TOOL_NAMES, explorerRuntimeTools } from "./explorerTools.js";
import { config } from "../../config.js";

export type ExplorerExecution = {
  result: AgentResult;
  exploration?: ExplorerResult;
  state: ReturnType<StateManager["getState"]>;
  diagnostics?: RuntimeExecutionDiagnostics;
};

function packetFromTask(task: Task, context: unknown = {}): AgentTaskPacket {
  return {
    taskId: task.id,
    goal: task.goal,
    context,
    constraints: [],
    acceptanceCriteria: [...task.acceptanceCriteria],
    readScope: [...task.readScope],
    writeScope: [],
    allowedTools: [...EXPLORER_TOOL_NAMES]
  };
}

/** 组装 Explorer 的独立 Runtime；调用方只能提交已存在于 Plan 中的 explore Task。 */
export class ExplorerAgentRuntime {
  constructor(private readonly agent: ExplorerAgent = new ExplorerAgent()) {}

  async executePlanTask(plan: Plan, taskId: string, context: unknown = {}, options: { signal?: AbortSignal } = {}): Promise<ExplorerExecution> {
    validatePlan(plan);
    const task = plan.tasks.find((item) => item.id === taskId);
    if (!task) throw runtimeError("TASK_NOT_FOUND", `计划中不存在任务 ${taskId}。`, { taskId });
    if (task.type !== "explore") throw runtimeError("INVALID_CONTRACT", `任务 ${taskId} 不是 explore Task。`, { taskId });
    if (task.writeScope.length) throw runtimeError("PERMISSION_DENIED", "Explorer Task 不能声明 writeScope。", { taskId });

    const initialState = createAgentState(plan.goal, plan);
    // 独立执行计划中的后续 explore Task 时恢复已完成依赖，避免把可信 Plan 进度丢失。
    initialState.completedTasks = plan.tasks.filter((item) => item.status === "completed").map((item) => item.id);
    initialState.failedTasks = plan.tasks.filter((item) => item.status === "failed").map((item) => item.id);
    const state = new StateManager(initialState);
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: new ToolRegistry(explorerRuntimeTools),
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: [...EXPLORER_TOOL_NAMES] }]),
      state,
      executionPolicy: config.agentRuntimeStabilityPolicy
    });
    const execution = await kernel.execute(this.agent.id, packetFromTask(task, context), options);
    const result = execution.result as Partial<ExplorerAgentResult>;
    if (execution.result.status === "success" && !result.exploration) {
      throw runtimeError("INVALID_CONTRACT", "Explorer 成功结果缺少结构化探索产物。", { taskId });
    }
    return {
      result: execution.result,
      ...(result.exploration ? { exploration: result.exploration } : {}),
      state: execution.state,
      diagnostics: execution.diagnostics
    };
  }
}
