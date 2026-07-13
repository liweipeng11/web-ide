import { appendAgentMessage, listAgentMessages, setPendingAgentToolCall } from "./agentMessageStore.js";
import { getAgentModeConfig, normalizeAgentMode, type AgentMode } from "./agentModes.js";
import { evaluateAgentToolApproval } from "./agentPermissions.js";
import type { AgentToolRegistry } from "./agentToolRegistry.js";
import type { AgentCompletionResponse, AgentContext, AgentMessage, AgentToolCall, AgentToolMessage } from "./agentToolTypes.js";
import { createAgentToolRuntime, executeAgentToolCall } from "./agentTools.js";
import { createAiRunId, logAi, requestChatCompletion } from "./aiHttp.js";
import { config } from "./config.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AgentMessage as PersistedAgentMessage, AgentStep, PendingAgentToolCall } from "./types.js";

export type AgentRuntimeResult = {
  status: "completed" | "awaiting_approval" | "step_limit_reached";
  runId: string;
  content: string;
  messages: AgentMessage[];
  agentContext: AgentContext;
  generatedPatchIds: string[];
  pendingToolCall?: PendingAgentToolCall | null;
};

export type AgentRuntimeOptions = {
  userRequest: string;
  messages?: AgentMessage[];
  agentContext?: AgentContext;
  registry?: AgentToolRegistry;
  maxSteps?: number;
  runId?: string;
  generatedPatchIds?: string[];
  taskSessionId?: string | null;
  mode?: AgentMode;
  onAgentStep?: (step: AgentStep) => void;
  requestCompletion?: (body: Record<string, unknown>) => Promise<AgentCompletionResponse>;
};

// 16 步在“搜索 -> 读取上下文 -> 发起补丁/命令审批”的链路里偏紧，
// 会导致任务在真正进入审批前就触发步数上限。
const DEFAULT_MAX_AGENT_STEPS = 24;
const TOOL_BUDGET_WARNING_REMAINING_STEPS = 3;
const REPEATED_TOOL_CALL_WARNING_THRESHOLD = 2;

function createDefaultAgentContext(userRequest: string): AgentContext {
  return {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: [],
    patternSearchPerformed: false,
    patternCandidateFiles: []
  };
}

function getPatternFinderBlockReason(toolName: string, agentContext: AgentContext, registry: AgentToolRegistry) {
  const editingTools = new Set(["proposePatch", "replaceInFile", "writeFile"]);
  if (!editingTools.has(toolName) || !registry.get("findSimilarPatterns")) return null;

  if (agentContext.patternSearchPerformed !== true) {
    return "Before editing, call findSimilarPatterns to inspect existing implementation patterns.";
  }

  const candidates = agentContext.patternCandidateFiles || [];
  if (candidates.length && !candidates.some((filePath) => agentContext.filesRead.includes(filePath))) {
    return "findSimilarPatterns returned candidate files. Read at least one candidate with readFile before editing.";
  }

  return null;
}

function createInitialMessages(userRequest: string, mode: AgentMode) {
  const modeConfig = getAgentModeConfig(mode);

  return [
    { role: "system" as const, content: modeConfig.systemPrompt },
    { role: "user" as const, content: userRequest }
  ];
}

function parseToolArguments(toolCall: AgentToolCall) {
  try {
    const value = JSON.parse(toolCall.function.arguments);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function getToolCallSignature(toolCall: AgentToolCall) {
  return `${toolCall.function.name}:${stableStringify(parseToolArguments(toolCall))}`;
}

function createToolBudgetWarningMessage(remainingSteps: number, hasGeneratedPatch: boolean): AgentMessage {
  const instruction = hasGeneratedPatch
    ? "A pending patch already exists. Stop calling tools unless approval is required, and provide the final concise Chinese summary now."
    : "If you have enough context, use proposePatch to create a reviewable pending patch before files are written. Use replaceInFile/writeFile only when the user explicitly requested direct editing or the patch path cannot safely complete the change. Avoid repeating search/read calls unless they are strictly necessary.";

  return {
    role: "user",
    content: `You are near the tool-call limit with ${remainingSteps} model step(s) left. ${instruction}`
  };
}

function createRepeatedToolWarningMessage(toolNames: string[]): AgentMessage {
  return {
    role: "user",
    content: `You repeated these tool calls: ${toolNames.join(", ")}. Reuse the existing tool results instead of calling the same tool with the same arguments again. If enough context is available, move to proposePatch for a reviewable pending patch, use replaceInFile/writeFile only as the direct-edit fallback, or provide the final answer.`
  };
}

async function persistAgentMessage(taskSessionId: string | null | undefined, message: AgentMessage) {
  if (!taskSessionId) return;

  // Runtime 内部使用 OpenAI tool_calls 结构，持久化时转换成任务会话的稳定结构，便于后续恢复执行。
  await appendAgentMessage(taskSessionId, {
    role: message.role,
    content: message.content ?? null,
    toolCallId: message.tool_call_id,
    toolCalls: message.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function.name,
      arguments: parseToolArguments(toolCall)
    }))
  });
}

function createBlockedToolMessage(toolCall: AgentToolCall, reason: string): AgentMessage {
  return {
    role: "tool",
    tool_call_id: toolCall.id,
    content: JSON.stringify({ error: reason, approval: "blocked", toolName: toolCall.function.name })
  };
}

function createRejectedToolMessage(pendingToolCall: PendingAgentToolCall): AgentToolMessage {
  return {
    role: "tool",
    tool_call_id: pendingToolCall.toolCallId,
    content: JSON.stringify({
      error: "User rejected this tool call.",
      approval: "rejected",
      toolName: pendingToolCall.toolName
    })
  };
}

function createToolCallFromPending(pendingToolCall: PendingAgentToolCall): AgentToolCall {
  return {
    id: pendingToolCall.toolCallId,
    type: "function",
    function: {
      name: pendingToolCall.toolName,
      arguments: JSON.stringify(pendingToolCall.arguments ?? {})
    }
  };
}

function restoreRuntimeMessage(message: PersistedAgentMessage): AgentMessage {
  return {
    role: message.role,
    content: message.content,
    tool_call_id: message.toolCallId,
    tool_calls: message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments ?? {})
      }
    }))
  };
}

function restoreRuntimeMessages(userRequest: string, mode: AgentMode, persistedMessages: PersistedAgentMessage[] = []) {
  const restoredMessages = persistedMessages.map(restoreRuntimeMessage);

  // 旧会话可能只持久化 assistant/tool 消息，恢复时补齐当前模式对应的系统提示词和用户目标。
  return restoredMessages.some((message) => message.role === "system") ? restoredMessages : [...createInitialMessages(userRequest, mode), ...restoredMessages];
}

export type ResumeAgentRuntimeAfterApprovalOptions = Omit<AgentRuntimeOptions, "messages"> & {
  pendingToolCall: PendingAgentToolCall;
  decision: "approved" | "rejected";
  persistedMessages?: PersistedAgentMessage[];
};

/**
 * 复用审批接口恢复连续 Agent：先把审批结果作为 tool 消息回填，再继续模型驱动循环。
 */
export async function resumeAgentRuntimeAfterApproval(options: ResumeAgentRuntimeAfterApprovalOptions): Promise<AgentRuntimeResult> {
  const mode = normalizeAgentMode(options.mode);
  const registry = options.registry || getAgentModeConfig(mode).registry;
  const runId = options.runId || createAiRunId("agent-resume");
  const persistedMessages = options.persistedMessages || (options.taskSessionId ? await listAgentMessages(options.taskSessionId) : []);
  const messages = restoreRuntimeMessages(options.userRequest, mode, persistedMessages);
  const agentContext = options.agentContext || createDefaultAgentContext(options.userRequest);
  const generatedPatchIds: string[] = [];
  const toolRuntime = createAgentToolRuntime({
    agentContext,
    runId,
    generatedPatchIds,
    taskSessionId: options.taskSessionId,
    onAgentStep: options.onAgentStep,
    registry,
    emitToolApprovalSteps: false,
    pendingActionId: options.pendingToolCall.actionId
  });
  const toolMessage =
    options.decision === "rejected"
      ? createRejectedToolMessage(options.pendingToolCall)
      : await executeAgentToolCall(createToolCallFromPending(options.pendingToolCall), toolRuntime);

  messages.push(toolMessage);
  await persistAgentMessage(options.taskSessionId, toolMessage);

  return runAgentRuntime({
    ...options,
    mode,
    runId,
    registry,
    messages,
    agentContext,
    generatedPatchIds
  });
}

/**
 * 连续 Agent Runtime：由模型决定下一步工具调用，服务端执行后把结果回填给模型。
 */
export async function runAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntimeResult> {
  const runId = options.runId || createAiRunId("agent-runtime");
  const mode = normalizeAgentMode(options.mode);
  const modeConfig = getAgentModeConfig(mode);
  const registry = options.registry || modeConfig.registry;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const requestCompletion = options.requestCompletion || ((body) => requestChatCompletion(body) as Promise<AgentCompletionResponse>);
  const agentContext = options.agentContext || createDefaultAgentContext(options.userRequest);
  const messages: AgentMessage[] = options.messages ? [...options.messages] : createInitialMessages(options.userRequest, mode);
  const generatedPatchIds = options.generatedPatchIds || [];
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, generatedPatchIds, taskSessionId: options.taskSessionId, onAgentStep: options.onAgentStep, registry, emitToolApprovalSteps: false });
  const toolCallCounts = new Map<string, number>();
  const repeatedToolWarnings = new Set<string>();
  let budgetWarningSent = false;

  logAi(runId, "runtime.start", { userGoal: agentContext.userGoal, mode, maxSteps, tools: registry.definitions.map((tool) => tool.name) });

  for (let step = 0; step < maxSteps; step += 1) {
    const remainingSteps = maxSteps - step;

    if (!budgetWarningSent && step > 0 && remainingSteps <= TOOL_BUDGET_WARNING_REMAINING_STEPS) {
      const warningMessage = createToolBudgetWarningMessage(remainingSteps, generatedPatchIds.length > 0);
      messages.push(warningMessage);
      await persistAgentMessage(options.taskSessionId, warningMessage);
      budgetWarningSent = true;
      // 把预算预警写入步骤流，前端可直接展示“即将触达工具预算”的观测信号。
      options.onAgentStep?.(createAgentStep({ type: "message", content: `Tool budget warning: ${remainingSteps} model step(s) remaining.` }));
      logAi(runId, "runtime.budgetWarning", { step, remainingSteps, generatedPatchIds });
    }

    logAi(runId, "runtime.completion.request", { step, messageCount: messages.length });
    const data = await requestCompletion({
      model: config.aiModel,
      temperature: config.aiChatTemperature,
      messages,
      tools: registry.schemas,
      tool_choice: "auto"
    });
    const message = data.choices?.[0]?.message;

    if (!message) {
      throw new Error("AI response did not include a message");
    }

    if (!message.tool_calls?.length) {
      const content = message.content || "";
      const assistantMessage: AgentMessage = { role: "assistant", content };
      messages.push(assistantMessage);
      await persistAgentMessage(options.taskSessionId, assistantMessage);
      options.onAgentStep?.(createAgentStep({ type: "message", content: content || "Agent runtime completed without text output." }));
      logAi(runId, "runtime.done", { step, mode, contentLength: content.length });
      return {
        status: "completed",
        runId,
        content,
        messages,
        agentContext,
        generatedPatchIds,
        pendingToolCall: null
      };
    }

    const assistantMessage: AgentMessage = {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls
    };
    messages.push(assistantMessage);
    await persistAgentMessage(options.taskSessionId, assistantMessage);

    logAi(runId, "runtime.toolCalls", message.tool_calls.map((toolCall) => toolCall.function.name));
    const repeatedToolNames: string[] = [];

    for (const toolCall of message.tool_calls) {
      const signature = getToolCallSignature(toolCall);
      const nextCount = (toolCallCounts.get(signature) || 0) + 1;
      toolCallCounts.set(signature, nextCount);

      if (nextCount >= REPEATED_TOOL_CALL_WARNING_THRESHOLD && !repeatedToolWarnings.has(signature)) {
        repeatedToolWarnings.add(signature);
        repeatedToolNames.push(toolCall.function.name);
      }
    }

    for (const toolCall of message.tool_calls) {
      const definition = registry.get(toolCall.function.name);
      const patternFinderBlockReason = getPatternFinderBlockReason(toolCall.function.name, agentContext, registry);

      if (patternFinderBlockReason) {
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.function.name, reason: patternFinderBlockReason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: patternFinderBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, patternFinderBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      const approval = evaluateAgentToolApproval(toolCall, definition);

      if (approval.status === "blocked") {
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.function.name, reason: approval.reason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: approval.reason }));
        const blockedMessage = createBlockedToolMessage(toolCall, approval.reason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }

      if (approval.status === "requires_approval") {
        options.onAgentStep?.(approval.step);
        const pendingToolCall: PendingAgentToolCall = {
          actionId: approval.step.type === "approval_request" ? approval.step.actionId : `tool_call:${toolCall.id}`,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          arguments: parseToolArguments(toolCall),
          riskLevel: approval.riskLevel,
          status: "pending",
          createdAt: Date.now()
        };

        await setPendingAgentToolCall(options.taskSessionId, pendingToolCall);
        logAi(runId, "runtime.awaitingApproval", { toolName: pendingToolCall.toolName, actionId: pendingToolCall.actionId });

        return {
          status: "awaiting_approval",
          runId,
          content: `Waiting for approval to run ${pendingToolCall.toolName}.`,
          messages,
          agentContext,
          generatedPatchIds,
          pendingToolCall
        };
      }

      const result = await executeAgentToolCall(toolCall, toolRuntime);
      messages.push(result);
      await persistAgentMessage(options.taskSessionId, result);
    }

    if (repeatedToolNames.length) {
      const repeatedWarningMessage = createRepeatedToolWarningMessage([...new Set(repeatedToolNames)]);
      messages.push(repeatedWarningMessage);
      await persistAgentMessage(options.taskSessionId, repeatedWarningMessage);
      logAi(runId, "runtime.repeatedToolWarning", { toolNames: repeatedToolNames });
    }
  }

  const content = `Tool budget limit reached: Agent runtime stopped after ${maxSteps} step(s) because the tool-call limit was reached.`;
  options.onAgentStep?.(createAgentStep({ type: "error", message: content }));
  logAi(runId, "runtime.stepLimitReached", { mode, maxSteps });

  return {
    status: "step_limit_reached",
    runId,
    content,
    messages,
    agentContext,
    generatedPatchIds,
    pendingToolCall: null
  };
}
