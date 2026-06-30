import { config } from "./config.js";
import { createAiRunId, logAi, requestChatCompletion } from "./aiHttp.js";
import { createAgentToolRuntime, executeAgentToolCall, readonlyAgentToolRegistry } from "./agentTools.js";
import type { AgentToolRegistry } from "./agentToolRegistry.js";
import { AI_AGENT_RUNTIME_SYSTEM_PROMPT } from "./prompts.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AgentStep } from "./types.js";
import type { AgentCompletionResponse, AgentContext, AgentMessage } from "./agentToolTypes.js";

export type AgentRuntimeResult = {
  status: "completed" | "step_limit_reached";
  runId: string;
  content: string;
  messages: AgentMessage[];
  agentContext: AgentContext;
};

export type AgentRuntimeOptions = {
  userRequest: string;
  messages?: AgentMessage[];
  agentContext?: AgentContext;
  registry?: AgentToolRegistry;
  maxSteps?: number;
  runId?: string;
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
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, onAgentStep: options.onAgentStep, registry });

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
      messages.push({ role: "assistant", content });
      options.onAgentStep?.(createAgentStep({ type: "message", content: content || "Agent runtime completed without text output." }));
      logAi(runId, "runtime.done", { step, contentLength: content.length });
      return {
        status: "completed",
        runId,
        content,
        messages,
        agentContext
      };
    }

    messages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls
    });

    logAi(runId, "runtime.toolCalls", message.tool_calls.map((toolCall) => toolCall.function.name));

    for (const toolCall of message.tool_calls) {
      const result = await executeAgentToolCall(toolCall, toolRuntime);
      messages.push(result);
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
    agentContext
  };
}
