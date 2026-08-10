import type { AgentResult, AgentTaskPacket, RuntimeExecutionResult } from "./contracts.js";
import { AgentRegistry } from "./agentRegistry.js";
import { PermissionManager } from "./permissionManager.js";
import { StateManager } from "./stateManager.js";
import { ToolRegistry } from "./toolRegistry.js";
import { runtimeError } from "./errors.js";

export type RuntimeKernelOptions = {
  agents: AgentRegistry;
  tools: ToolRegistry;
  permissions: PermissionManager;
  state: StateManager;
};

function createFailedResult(taskId: string, error: unknown): AgentResult {
  const reason = error instanceof Error ? error.message : "Agent 执行时发生未知错误。";
  return {
    taskId,
    status: "failed",
    summary: "Agent 执行失败。",
    facts: [],
    changedFiles: [],
    evidence: [],
    blockers: [reason]
  };
}

function hasSameStrings(actual: string[], expected: string[]) {
  const actualValues = [...new Set(actual)].sort();
  const expectedValues = [...new Set(expected)].sort();
  return actualValues.length === expectedValues.length
    && actualValues.every((value, index) => value === expectedValues[index]);
}

function assertTaskPacketMatchesPlan(task: AgentTaskPacket, plannedTask: ReturnType<StateManager["getTask"]>) {
  const mismatchedFields: string[] = [];
  if (task.goal.trim() !== plannedTask.goal.trim()) mismatchedFields.push("goal");
  if (!hasSameStrings(task.acceptanceCriteria, plannedTask.acceptanceCriteria)) mismatchedFields.push("acceptanceCriteria");
  if (!hasSameStrings(task.readScope, plannedTask.readScope)) mismatchedFields.push("readScope");
  if (!hasSameStrings(task.writeScope, plannedTask.writeScope)) mismatchedFields.push("writeScope");

  // TaskPacket 是委派载荷，不能覆盖 Plan 中由 Main 持有的目标和安全边界。
  if (mismatchedFields.length) {
    throw runtimeError("INVALID_CONTRACT", `TaskPacket 与 Plan 中的任务定义不一致：${mismatchedFields.join("、")}`, {
      taskId: task.taskId,
      mismatchedFields
    });
  }
}

function assertAgentResult(result: AgentResult) {
  const validStatuses = new Set(["success", "failed", "blocked"]);
  const arrayFields: Array<keyof Pick<AgentResult, "facts" | "changedFiles" | "evidence" | "blockers">> = [
    "facts",
    "changedFiles",
    "evidence",
    "blockers"
  ];
  if (!result || typeof result !== "object" || typeof result.taskId !== "string" || typeof result.summary !== "string") {
    throw runtimeError("INVALID_CONTRACT", "Agent 必须返回合法的 AgentResult。");
  }
  if (!validStatuses.has(result.status)) {
    throw runtimeError("INVALID_CONTRACT", `AgentResult.status 无效：${String(result.status)}`);
  }
  for (const field of arrayFields) {
    if (!Array.isArray(result[field]) || result[field].some((value) => typeof value !== "string")) {
      throw runtimeError("INVALID_CONTRACT", `AgentResult.${field} 必须是字符串数组。`, { field });
    }
  }
  if (result.scopeChangeRequest
    && (typeof result.scopeChangeRequest.reason !== "string"
      || !Array.isArray(result.scopeChangeRequest.requiredScope)
      || result.scopeChangeRequest.requiredScope.some((value) => typeof value !== "string"))) {
    throw runtimeError("INVALID_CONTRACT", "AgentResult.scopeChangeRequest 格式无效。");
  }
}

/** 阶段 0 的最小执行内核：只执行明确指定的 Agent，不进行意图识别或自动规划。 */
export class RuntimeKernel {
  constructor(private readonly options: RuntimeKernelOptions) {}

  async execute(agentId: string, task: AgentTaskPacket): Promise<RuntimeExecutionResult> {
    const plannedTask = this.options.state.getTask(task.taskId);
    assertTaskPacketMatchesPlan(task, plannedTask);
    const agent = this.options.agents.requireCapabilities(agentId, plannedTask.requiredCapabilities);
    this.options.state.startTask(task.taskId);

    const context = {
      agentId,
      state: this.options.state.getState(),
      callTool: async (toolName: string, args: Record<string, unknown>) => {
        const tool = this.options.tools.get(toolName);
        this.options.permissions.checkTool(agentId, task, tool, args);
        return tool.execute(args, { agentId, task });
      }
    };

    let result: AgentResult;
    try {
      result = await agent.run(task, context);
      assertAgentResult(result);
      this.options.permissions.checkResult(task, result);
    } catch (error) {
      result = createFailedResult(task.taskId, error);
    }

    this.options.state.applyResult(result);
    return { result, state: this.options.state.getState() };
  }
}
