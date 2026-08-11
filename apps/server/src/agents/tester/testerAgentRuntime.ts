import type { AgentResult, AgentTaskPacket, Plan, Task } from "../../runtime/contracts.js";
import { AgentRegistry } from "../../runtime/agentRegistry.js";
import { PermissionManager } from "../../runtime/permissionManager.js";
import { RuntimeKernel } from "../../runtime/runtimeKernel.js";
import { createAgentState, StateManager, validatePlan } from "../../runtime/stateManager.js";
import { ToolRegistry } from "../../runtime/toolRegistry.js";
import { runtimeError } from "../../runtime/errors.js";
import type { AcceptanceEvidenceInput, TesterAgentResult, ValidationReport } from "./contracts.js";
import { TesterAgent } from "./testerAgent.js";
import { TESTER_TOOL_NAMES, testerRuntimeTools } from "./testerTools.js";

export type TesterTaskOptions = {
  context?: unknown;
  constraints?: string[];
  changedFiles: string[];
  testScope: string[];
  acceptanceEvidence?: AcceptanceEvidenceInput[];
};

export type TesterExecution = {
  result: AgentResult;
  validation?: ValidationReport;
  state: ReturnType<StateManager["getState"]>;
};

function packetFromTask(task: Task, options: TesterTaskOptions): AgentTaskPacket {
  return {
    taskId: task.id,
    goal: task.goal,
    context: {
      ...(options.context && typeof options.context === "object" && !Array.isArray(options.context) ? options.context : {}),
      changedFiles: [...new Set(options.changedFiles.map((item) => item.trim()).filter(Boolean))],
      testScope: [...new Set(options.testScope.map((item) => item.trim()).filter(Boolean))],
      acceptanceEvidence: options.acceptanceEvidence?.map((item) => ({
        criterion: item.criterion.trim(),
        testFiles: [...new Set(item.testFiles.map((filePath) => filePath.trim()).filter(Boolean))]
      })) ?? []
    },
    constraints: [...new Set(options.constraints?.map((item) => item.trim()).filter(Boolean) ?? [])],
    acceptanceCriteria: [...task.acceptanceCriteria],
    readScope: [...task.readScope],
    writeScope: [],
    allowedTools: [...TESTER_TOOL_NAMES]
  };
}

/** 组装 Tester 的独立只读 Runtime，只执行依赖已满足的 test Task。 */
export class TesterAgentRuntime {
  constructor(private readonly agent: TesterAgent = new TesterAgent()) {}

  async executePlanTask(plan: Plan, taskId: string, options: TesterTaskOptions): Promise<TesterExecution> {
    validatePlan(plan);
    const task = plan.tasks.find((item) => item.id === taskId);
    if (!task) throw runtimeError("TASK_NOT_FOUND", `计划中不存在任务 ${taskId}。`, { taskId });
    if (task.type !== "test") throw runtimeError("INVALID_CONTRACT", `任务 ${taskId} 不是 test Task。`, { taskId });
    if (task.writeScope.length) throw runtimeError("INVALID_CONTRACT", `测试任务 ${taskId} 的 writeScope 必须为空。`, { taskId });
    if (!options.changedFiles.length) throw runtimeError("INVALID_CONTRACT", "Tester 至少需要一个 changedFile 作为验证范围依据。");
    if (!options.testScope.length) throw runtimeError("INVALID_CONTRACT", "Tester 至少需要一个 testScope。");

    const initialState = createAgentState(plan.goal, plan);
    initialState.completedTasks = plan.tasks.filter((item) => item.status === "completed").map((item) => item.id);
    initialState.failedTasks = plan.tasks.filter((item) => item.status === "failed").map((item) => item.id);
    const state = new StateManager(initialState);
    const kernel = new RuntimeKernel({
      agents: new AgentRegistry([this.agent]),
      tools: new ToolRegistry(testerRuntimeTools),
      permissions: new PermissionManager([{ agentId: this.agent.id, allowedTools: [...TESTER_TOOL_NAMES] }]),
      state
    });
    const execution = await kernel.execute(this.agent.id, packetFromTask(task, options));
    const result = execution.result as Partial<TesterAgentResult>;
    if (execution.result.status === "success" && !result.validation) {
      throw runtimeError(
        "INVALID_CONTRACT",
        `Tester 结果缺少结构化 ValidationReport：${execution.result.blockers.join("；") || "未知原因"}`,
        { taskId, blockers: execution.result.blockers }
      );
    }
    return {
      result: execution.result,
      ...(result.validation ? { validation: result.validation } : {}),
      state: execution.state
    };
  }
}
