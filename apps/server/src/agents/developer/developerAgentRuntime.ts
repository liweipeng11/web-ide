import type { AgentResult, AgentTaskPacket, Plan, Task } from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager, validatePlan } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import { runtimeError } from "../../runtime/errors.js";
import type { DeveloperAgentResult, DeveloperCompletion } from "./contracts.js";
import { DeveloperAgent } from "./developerAgent.js";
import { DEVELOPER_TOOL_NAMES, developerRuntimeTools } from "./developerTools.js";

export type DeveloperTaskOptions = {
  context?: unknown;
  constraints?: string[];
};

export type DeveloperExecution = {
  result: AgentResult;
  implementation?: DeveloperCompletion;
  checkpointIds: string[];
  state: ReturnType<StateManager["getState"]>;
};

function packetFromTask(task: Task, options: DeveloperTaskOptions): AgentTaskPacket {
  return {
    taskId: task.id,
    goal: task.goal,
    context: options.context ?? {},
    constraints: [...new Set(options.constraints?.map((item) => item.trim()).filter(Boolean) ?? [])],
    acceptanceCriteria: [...task.acceptanceCriteria],
    readScope: [...task.readScope],
    writeScope: [...task.writeScope],
    allowedTools: [...DEVELOPER_TOOL_NAMES]
  };
}

/** 组装 Developer 的独立 Runtime，只执行 Plan 中依赖已满足的 implement Task。 */
export class DeveloperAgentRuntime {
  constructor(private readonly agent: DeveloperAgent = new DeveloperAgent()) {}

  async executePlanTask(plan: Plan, taskId: string, options: DeveloperTaskOptions = {}): Promise<DeveloperExecution> {
    validatePlan(plan);
    const task = plan.tasks.find((item) => item.id === taskId);
    if (!task) throw runtimeError("TASK_NOT_FOUND", `计划中不存在任务 ${taskId}。`, { taskId });
    if (task.type !== "implement") {
      throw runtimeError("INVALID_CONTRACT", `任务 ${taskId} 不是 implement Task。`, { taskId });
    }
    if (!task.writeScope.length) {
      throw runtimeError("INVALID_CONTRACT", `实现任务 ${taskId} 必须声明非空 writeScope。`, { taskId });
    }

    const initialState = createAgentState(plan.goal, plan);
    // 恢复可信 Plan 的已完成依赖，由 StateManager 在启动任务时再次执行依赖门禁。
    initialState.completedTasks = plan.tasks.filter((item) => item.status === "completed").map((item) => item.id);
    initialState.failedTasks = plan.tasks.filter((item) => item.status === "failed").map((item) => item.id);
    const state = new StateManager(initialState);
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: new ToolRegistry(developerRuntimeTools),
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: [...DEVELOPER_TOOL_NAMES] }]),
      state
    });
    const execution = await kernel.execute(this.agent.id, packetFromTask(task, options));
    const result = execution.result as Partial<DeveloperAgentResult>;
    if (execution.result.status === "success" && !result.implementation) {
      throw runtimeError("INVALID_CONTRACT", "Developer 成功结果缺少结构化实现摘要。", { taskId });
    }
    return {
      result: execution.result,
      ...(result.implementation ? { implementation: result.implementation } : {}),
      checkpointIds: result.checkpointIds ?? [],
      state: execution.state
    };
  }
}
