import { config } from "./config.js";
import { createAiRunId, logAi, requestChatCompletion } from "./aiHttp.js";
import { createAgentToolRuntime, executeAgentToolCall, readonlyAgentToolRegistry } from "./agentTools.js";
import type { AgentToolRegistry } from "./agentToolRegistry.js";
import { appendAgentMessage, listAgentMessages, setPendingAgentToolCall } from "./agentMessageStore.js";
import { evaluateAgentToolApproval } from "./agentPermissions.js";
import { AI_AGENT_RUNTIME_SYSTEM_PROMPT } from "./prompts.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AgentMessage as PersistedAgentMessage, AgentStep, PendingAgentToolCall } from "./types.js";
import type { AgentCompletionResponse, AgentContext, AgentMessage, AgentToolCall, AgentToolMessage } from "./agentToolTypes.js";

export type AgentRuntimeResult = {
  status: "completed" | "awaiting_approval" | "step_limit_reached";
  runId: string;
  content: string;
  messages: AgentMessage[];
  agentContext: AgentContext;
  pendingToolCall?: PendingAgentToolCall | null;
};

export type AgentRuntimeOptions = {
  userRequest: string;
  messages?: AgentMessage[];
  agentContext?: AgentContext;
  registry?: AgentToolRegistry;
  maxSteps?: number;
  runId?: string;
  taskSessionId?: string | null;
  onAgentStep?: (step: AgentStep) => void;
  requestCompletion?: (body: Record<string, unknown>) => Promise<AgentCompletionResponse>;
};

const DEFAULT_MAX_AGENT_STEPS = 8;

function createDefaultAgentContext(userRequest: string): AgentContext {
  return {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: []
  };
}

function createInitialMessages(userRequest: string) {
  return [
    { role: "system" as const, content: AI_AGENT_RUNTIME_SYSTEM_PROMPT },
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

async function persistAgentMessage(taskSessionId: string | null | undefined, message: AgentMessage) {
  if (!taskSessionId) return;

  // Runtime 内部使用 OpenAI tool_calls 结构，持久化时转成任务会话稳定结构，便于后续恢复执行。
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

function restoreRuntimeMessages(userRequest: string, persistedMessages: PersistedAgentMessage[] = []) {
  const restoredMessages = persistedMessages.map(restoreRuntimeMessage);

  // 旧会话只持久化 assistant/tool 消息，恢复时需要补回系统提示词和用户目标。
  return restoredMessages.some((message) => message.role === "system") ? restoredMessages : [...createInitialMessages(userRequest), ...restoredMessages];
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
  const registry = options.registry || readonlyAgentToolRegistry;
  const runId = options.runId || createAiRunId("agent-resume");
  const persistedMessages = options.persistedMessages || (options.taskSessionId ? await listAgentMessages(options.taskSessionId) : []);
  const messages = restoreRuntimeMessages(options.userRequest, persistedMessages);
  const agentContext = options.agentContext || createDefaultAgentContext(options.userRequest);
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, onAgentStep: options.onAgentStep, registry, emitToolApprovalSteps: false });
  const toolMessage =
    options.decision === "rejected"
      ? createRejectedToolMessage(options.pendingToolCall)
      : await executeAgentToolCall(createToolCallFromPending(options.pendingToolCall), toolRuntime);

  messages.push(toolMessage);
  await persistAgentMessage(options.taskSessionId, toolMessage);

  return runAgentRuntime({
    ...options,
    runId,
    registry,
    messages,
    agentContext
  });
}

/**
 * 连续 Agent Runtime：由模型决定下一步工具调用，服务端执行后把结果回填给模型。
 */
export async function runAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntimeResult> {
  const runId = options.runId || createAiRunId("agent-runtime");
  const registry = options.registry || readonlyAgentToolRegistry;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const requestCompletion = options.requestCompletion || ((body) => requestChatCompletion(body) as Promise<AgentCompletionResponse>);
  const agentContext = options.agentContext || createDefaultAgentContext(options.userRequest);
  const messages: AgentMessage[] = options.messages ? [...options.messages] : createInitialMessages(options.userRequest);
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, onAgentStep: options.onAgentStep, registry, emitToolApprovalSteps: false });

  logAi(runId, "runtime.start", { userGoal: agentContext.userGoal, maxSteps, tools: registry.definitions.map((tool) => tool.name) });

  for (let step = 0; step < maxSteps; step += 1) {
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
      logAi(runId, "runtime.done", { step, contentLength: content.length });
      return {
        status: "completed",
        runId,
        content,
        messages,
        agentContext,
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

    for (const toolCall of message.tool_calls) {
      const definition = registry.get(toolCall.function.name);
      const approval = evaluateAgentToolApproval(toolCall, definition);

      if (approval.status === "blocked") {
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.function.name, reason: approval.reason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: approval.reason }));
        const blockedMessage = createBlockedToolMessage(toolCall, approval.reason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }

      options.onAgentStep?.(approval.step);

      if (approval.status === "requires_approval") {
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
          pendingToolCall
        };
      }

      const result = await executeAgentToolCall(toolCall, toolRuntime);
      messages.push(result);
      await persistAgentMessage(options.taskSessionId, result);
    }
  }

  const content = `Agent runtime stopped after ${maxSteps} step(s) because the tool-call limit was reached.`;
  options.onAgentStep?.(createAgentStep({ type: "error", message: content }));
  logAi(runId, "runtime.stepLimitReached", { maxSteps });

  return {
    status: "step_limit_reached",
    runId,
    content,
    messages,
    agentContext,
    pendingToolCall: null
  };
}
