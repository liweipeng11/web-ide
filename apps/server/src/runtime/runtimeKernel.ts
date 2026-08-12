import type { AgentResult, AgentTaskPacket, RuntimeExecutionResult, RuntimeFailureCategory } from "./contracts.js";
import { AgentRegistry } from "./agentRegistry.js";
import { PermissionManager } from "./permissionManager.js";
import { StateManager } from "./stateManager.js";
import { ToolRegistry } from "./toolRegistry.js";
import { runtimeError } from "./errors.js";
import {
  abortableDelay,
  DEFAULT_RUNTIME_EXECUTION_POLICY,
  retryDelayMs,
  runControlled,
  type RuntimeExecutionPolicy,
  validateRuntimeExecutionPolicy
} from "./executionControl.js";
import { classifyRuntimeError, shouldRetryRuntimeError } from "./retryPolicy.js";

export type RuntimeKernelOptions = {
  agents: AgentRegistry;
  tools: ToolRegistry;
  permissions: PermissionManager;
  state: StateManager;
  executionPolicy?: Partial<RuntimeExecutionPolicy>;
};

function createFailedResult(taskId: string, error: unknown): AgentResult {
  const reason = error instanceof Error ? error.message : "Agent 执行时发生未知错误。";
  return {
    taskId,
    status: "failed",
    // 将安全的失败原因写入摘要，供任务历史和对话直接定位问题。
    summary: `Agent 执行失败：${reason}`,
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
  private readonly executionPolicy: RuntimeExecutionPolicy;

  constructor(private readonly options: RuntimeKernelOptions) {
    this.executionPolicy = { ...DEFAULT_RUNTIME_EXECUTION_POLICY, ...options.executionPolicy };
    validateRuntimeExecutionPolicy(this.executionPolicy);
  }

  async execute(agentId: string, task: AgentTaskPacket, options: { signal?: AbortSignal } = {}): Promise<RuntimeExecutionResult> {
    const plannedTask = this.options.state.getTask(task.taskId);
    assertTaskPacketMatchesPlan(task, plannedTask);
    const agent = this.options.agents.requireCapabilities(agentId, plannedTask.requiredCapabilities);
    this.options.state.startTask(task.taskId);

    const startedAt = Date.now();
    let attempts = 0;
    let failureCategory: RuntimeFailureCategory = "none";
    let retryable = false;
    let sideEffectStarted = false;
    let result: AgentResult | null = null;

    while (attempts < this.executionPolicy.maxAttempts) {
      attempts += 1;
      try {
        result = await runControlled({
          timeoutMs: this.executionPolicy.timeoutMs,
          signal: options.signal,
          operation: async (signal) => {
            const context = {
              agentId,
              state: this.options.state.getState(),
              availableTools: this.options.tools.describeAvailable(task.allowedTools),
              signal,
              getState: () => this.options.state.getState(),
              callTool: async (toolName: string, args: Record<string, unknown>) => {
                if (signal.aborted) throw runtimeError("AGENT_CANCELLED", "Agent 工具调用已取消。", { toolName });
                const tool = this.options.tools.get(toolName);
                this.options.permissions.checkTool(agentId, task, tool, args);
                // 写入和命令执行一旦开始，就禁止整体 Agent 自动重跑，避免重复副作用。
                if (tool.effect === "write" || tool.effect === "execute") sideEffectStarted = true;
                const toolResult = await tool.execute(args, { agentId, task, signal });
                const changedFiles = tool.getChangedFiles?.(args, toolResult) ?? [];
                if (changedFiles.length) {
                  // 工具声明的变更必须再次经过任务写范围校验，不能依赖模型自报路径。
                  this.options.permissions.checkResult(task, {
                    taskId: task.taskId,
                    status: "success",
                    summary: "工具执行进度",
                    facts: [],
                    changedFiles,
                    evidence: [],
                    blockers: []
                  });
                  this.options.state.recordProgress(task.taskId, {
                    changedFiles,
                    facts: [`工具 ${toolName} 已完成受控写入。`]
                  });
                }
                return toolResult;
              }
            };
            const agentResult = await agent.run(task, context);
            assertAgentResult(agentResult);
            this.options.permissions.checkResult(task, agentResult);
            return agentResult;
          }
        });
        failureCategory = result.status === "failed"
          ? agentId === "tester" ? "validation_failure" : "internal_error"
          : "none";
        retryable = false;
        break;
      } catch (error) {
        const state = this.options.state.getState();
        const decision = shouldRetryRuntimeError({
          error,
          attempt: attempts,
          maxAttempts: this.executionPolicy.maxAttempts,
          hasChangedFiles: sideEffectStarted || state.changedFiles.length > 0,
          externallyAborted: options.signal?.aborted === true
        });
        failureCategory = decision.category;
        retryable = decision.retryable;
        if (!decision.shouldRetry) {
          result = createFailedResult(task.taskId, error);
          break;
        }
        try {
          await abortableDelay(retryDelayMs(this.executionPolicy, attempts), options.signal);
        } catch (delayError) {
          const classification = classifyRuntimeError(delayError);
          failureCategory = classification.category;
          retryable = classification.retryable;
          result = createFailedResult(task.taskId, delayError);
          break;
        }
      }
    }

    if (!result) {
      const error = runtimeError("AGENT_RETRY_EXHAUSTED", `Agent 在 ${attempts} 次尝试后仍未成功。`, { attempts });
      result = createFailedResult(task.taskId, error);
      const classification = classifyRuntimeError(error);
      failureCategory = classification.category;
      retryable = classification.retryable;
    }

    this.options.state.applyResult(result);
    const finishedAt = Date.now();
    return {
      result,
      state: this.options.state.getState(),
      diagnostics: {
        attempts,
        retries: Math.max(0, attempts - 1),
        startedAt,
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        timeoutMs: this.executionPolicy.timeoutMs,
        failureCategory,
        retryable
      }
    };
  }
}
