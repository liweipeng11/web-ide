import crypto from "node:crypto";
import { appendAgentMessage, listAgentMessages, setPendingAgentToolCall } from "./agentMessageStore.js";
import { getAgentModeConfig, normalizeAgentMode, type AgentMode } from "./agentModes.js";
import { evaluateAgentToolApproval } from "./agentPermissions.js";
import type { AgentToolRegistry } from "./agentToolRegistry.js";
import type { AgentCompletionResponse, AgentContext, AgentToolCall } from "./agentToolTypes.js";
import { createAgentToolRuntime, executeAgentToolCall } from "./agentTools.js";
import { createAiRunId, logAi, requestChatCompletion } from "./aiHttp.js";
import { config } from "./config.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AgentMessage as PersistedAgentMessage, AgentStep, PendingAgentToolCall } from "./types.js";
import { buildTaskWorkflowRuntimePrompt, type TaskWorkflowSnapshot } from "./taskWorkflow/index.js";
import { getCurrentProjectMemoryPrompt } from "./projectMemory/index.js";
import { adaptOpenAiCompletionResponse, toOpenAiChatCompletionBody, type ModelDescriptor, type ModelMessage, type ModelRequest, type ModelResponse, type ModelToolCall } from "./contracts/index.js";
import { RunMetricsTracker, classifyRunFailure, type RunMetricsRecorder } from "./observability/index.js";
import { getPendingPatch } from "./patchStore.js";
import { ConservativeTokenEstimator, prepareContextBudget } from "./contextBudget/index.js";
import type { ContextBudgetSnapshot, StructuredContextSummary } from "./contracts/context.js";
import { implementedFeatures } from "./featureFlags.js";
import { getTaskSessionContextState, recordTaskSessionContextBudget } from "./taskSessionStore.js";
import { createStructuredContextSummary } from "./contextBudget/summary.js";
import { providerGateway } from "./providers/index.js";

export type AgentRuntimeResult = {
  status: "completed" | "awaiting_approval" | "step_limit_reached";
  runId: string;
  content: string;
  messages: ModelMessage[];
  agentContext: AgentContext;
  generatedPatchIds: string[];
  pendingToolCall?: PendingAgentToolCall | null;
  contextBudgetSnapshot?: ContextBudgetSnapshot;
  contextSummary?: StructuredContextSummary | null;
};

export type AgentRuntimeOptions = {
  userRequest: string;
  messages?: ModelMessage[];
  agentContext?: AgentContext;
  registry?: AgentToolRegistry;
  maxSteps?: number;
  runId?: string;
  generatedPatchIds?: string[];
  taskSessionId?: string | null;
  mode?: AgentMode;
  workflow?: TaskWorkflowSnapshot;
  projectMemoryPrompt?: string | null;
  onAgentStep?: (step: AgentStep) => void;
  requestCompletion?: (body: Record<string, unknown>) => Promise<AgentCompletionResponse | ModelResponse>;
  completeModel?: (request: ModelRequest) => Promise<ModelResponse>;
  metricsRecorder?: RunMetricsRecorder;
  providerId?: string;
  modelId?: string;
  contextBudgetEnabled?: boolean;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  contextSafetyMarginTokens?: number;
  modelDescriptor?: ModelDescriptor;
  signal?: AbortSignal;
  onContextBudget?: (event: { snapshot: ContextBudgetSnapshot; summary: StructuredContextSummary | null }) => void;
};

async function loadRuntimeContextState(taskSessionId: string | null | undefined) {
  if (!taskSessionId) return { planStatus: [] as string[], filesModified: [] as string[], unresolvedQuestions: [] as string[], contextSummary: null as StructuredContextSummary | null };
  try {
    const session = await getTaskSessionContextState(taskSessionId);
    return {
      planStatus: [
        ...(session.planItems ?? []).map((item) => `${item.status}: ${item.title}${item.note ? `（${item.note}）` : ""}`),
        `approval: ${session.planApproval?.status ?? "not_required"}`
      ],
      filesModified: [...session.filesChanged],
      unresolvedQuestions: (session.planItems ?? []).filter((item) => item.status === "blocked").map((item) => item.note || item.title),
      contextSummary: session.contextSummary ?? null
    };
  } catch {
    // 无持久化任务的单元调用继续使用 Runtime 内存状态。
    return { planStatus: [] as string[], filesModified: [] as string[], unresolvedQuestions: [] as string[], contextSummary: null as StructuredContextSummary | null };
  }
}

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
    patternCandidateFiles: [],
    existenceCheckPerformed: false,
    unresolvedExistenceChecks: [],
    commandsRun: [],
    externalSources: []
  };
}

function normalizeInjectedCompletion(response: AgentCompletionResponse | ModelResponse): ModelResponse {
  return "message" in response ? response as ModelResponse : adaptOpenAiCompletionResponse(response);
}

function snapshotAgentContext(agentContext: AgentContext): AgentContext {
  // 只复制可序列化字段，避免审批等待期间后续内存修改污染持久化快照。
  return {
    ...agentContext,
    filesRead: [...agentContext.filesRead],
    searchQueries: [...agentContext.searchQueries],
    searchResultFiles: [...agentContext.searchResultFiles],
    relevantFiles: [...agentContext.relevantFiles],
    patternCandidateFiles: agentContext.patternCandidateFiles ? [...agentContext.patternCandidateFiles] : undefined,
    unresolvedExistenceChecks: agentContext.unresolvedExistenceChecks ? [...agentContext.unresolvedExistenceChecks] : undefined,
    impactAnalyses: agentContext.impactAnalyses ? structuredClone(agentContext.impactAnalyses) : undefined,
    commandsRun: agentContext.commandsRun ? agentContext.commandsRun.map((command) => ({ ...command })) : undefined,
    externalSources: agentContext.externalSources ? agentContext.externalSources.map((source) => ({ ...source })) : undefined
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

function getExistenceCheckBlockReason(toolName: string, agentContext: AgentContext, registry: AgentToolRegistry) {
  const editingTools = new Set(["proposePatch", "replaceInFile", "writeFile"]);
  if (!editingTools.has(toolName) || !registry.get("checkExistence")) return null;
  if (agentContext.existenceCheckPerformed !== true) return "Before editing, call checkExistence to verify referenced imports, symbols, scripts, or directories.";
  if (agentContext.unresolvedExistenceChecks?.length) return `Resolve missing or ambiguous references before editing: ${agentContext.unresolvedExistenceChecks.join(", ")}.`;
  return null;
}

function getWorkflowToolBlockReason(toolName: string, agentContext: AgentContext, workflow?: TaskWorkflowSnapshot) {
  if (!workflow) return null;
  const editingTools = new Set(["proposePatch", "replaceInFile", "writeFile", "applyPatch"]);
  const sideEffectTools = new Set([...editingTools, "runCommand", "automateBrowser"]);

  if (workflow.type === "analysis-only" && sideEffectTools.has(toolName)) {
    return `Task workflow ${workflow.type} only allows read-only inspection tools.`;
  }

  if (workflow.type === "refactor" && editingTools.has(toolName) && !(agentContext.impactAnalyses?.length)) {
    return "Refactor workflow requires analyzeImpact evidence before editing.";
  }

  if (workflow.type === "bugfix" && editingTools.has(toolName) && !agentContext.filesRead.length) {
    return "Bugfix workflow requires reading failure-related code or evidence before editing.";
  }

  if (workflow.type === "bugfix" && editingTools.has(toolName) && !(agentContext.commandsRun?.length)) {
    return "Bugfix workflow requires a reproduction or validation command attempt before editing.";
  }

  return null;
}

async function loadProjectMemoryPrompt() {
  return getCurrentProjectMemoryPrompt();
}

function createInitialMessages(userRequest: string, mode: AgentMode, workflow?: TaskWorkflowSnapshot, projectMemoryPrompt = "") {
  const modeConfig = getAgentModeConfig(workflow?.type === "analysis-only" ? "plan" : mode);
  const systemPrompt = [modeConfig.systemPrompt, workflow ? buildTaskWorkflowRuntimePrompt(workflow) : "", projectMemoryPrompt].filter(Boolean).join("\n\n");

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userRequest }
  ];
}

function toAgentToolCall(toolCall: ModelToolCall): AgentToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.rawArguments ?? JSON.stringify(toolCall.arguments)
    }
  };
}

function toModelToolMessage(message: Awaited<ReturnType<typeof executeAgentToolCall>>): ModelMessage {
  return { role: "tool", toolCallId: message.tool_call_id, content: message.content };
}

function countGeneratedPatchFiles(patchIds: string[]) {
  return patchIds.reduce((count, patchId) => count + (getPendingPatch(patchId)?.files.length ?? 0), 0);
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function getToolCallSignature(toolCall: ModelToolCall) {
  return `${toolCall.name}:${stableStringify(toolCall.arguments)}`;
}

function createToolBudgetWarningMessage(remainingSteps: number, hasGeneratedPatch: boolean): ModelMessage {
  const instruction = hasGeneratedPatch
    ? "A pending patch already exists. Stop calling tools unless approval is required, and provide the final concise Chinese summary now."
    : "If you have enough context, use proposePatch to create a reviewable pending patch before files are written. Use replaceInFile/writeFile only when the user explicitly requested direct editing or the patch path cannot safely complete the change. Avoid repeating search/read calls unless they are strictly necessary.";

  return {
    role: "user",
    content: `You are near the tool-call limit with ${remainingSteps} model step(s) left. ${instruction}`
  };
}

function createRepeatedToolWarningMessage(toolNames: string[]): ModelMessage {
  return {
    role: "user",
    content: `You repeated these tool calls: ${toolNames.join(", ")}. Reuse the existing tool results instead of calling the same tool with the same arguments again. If enough context is available, move to proposePatch for a reviewable pending patch, use replaceInFile/writeFile only as the direct-edit fallback, or provide the final answer.`
  };
}

async function persistAgentMessage(taskSessionId: string | null | undefined, message: ModelMessage) {
  if (!taskSessionId) return;

  message.id ??= `agent-message-${crypto.randomUUID()}`;
  message.createdAt ??= Date.now();

  // Runtime 和持久化层共享 Provider 无关结构，OpenAI 字段只存在于兼容适配器。
  await appendAgentMessage(taskSessionId, {
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    content: message.content ?? null,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments
    }))
  });
}

function createBlockedToolMessage(toolCall: ModelToolCall, reason: string): ModelMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: JSON.stringify({ error: reason, approval: "blocked", toolName: toolCall.name })
  };
}

function createRejectedToolMessage(pendingToolCall: PendingAgentToolCall): ModelMessage {
  return {
    role: "tool",
    toolCallId: pendingToolCall.toolCallId,
    content: JSON.stringify({
      error: "User rejected this tool call.",
      approval: "rejected",
      toolName: pendingToolCall.toolName
    })
  };
}

function createToolCallFromPending(pendingToolCall: PendingAgentToolCall): ModelToolCall {
  return {
    id: pendingToolCall.toolCallId,
    name: pendingToolCall.toolName,
    arguments: (pendingToolCall.arguments ?? {}) as Record<string, unknown>
  };
}

function restoreRuntimeMessage(message: PersistedAgentMessage): ModelMessage {
  return {
    id: message.id,
    createdAt: message.createdAt,
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolCalls: message.toolCalls?.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: (toolCall.arguments ?? {}) as Record<string, unknown>
    }))
  };
}

function restoreRuntimeMessages(userRequest: string, mode: AgentMode, persistedMessages: PersistedAgentMessage[] = [], workflow?: TaskWorkflowSnapshot, projectMemoryPrompt = "") {
  const restoredMessages = persistedMessages.map(restoreRuntimeMessage);

  // 旧会话可能只持久化 assistant/tool 消息，恢复时补齐当前模式对应的系统提示词和用户目标。
  return restoredMessages.some((message) => message.role === "system") ? restoredMessages : [...createInitialMessages(userRequest, mode, workflow, projectMemoryPrompt), ...restoredMessages];
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
  const registry = options.registry || getAgentModeConfig(options.workflow?.type === "analysis-only" ? "plan" : mode).registry;
  const runId = options.runId || createAiRunId("agent-resume");
  const persistedMessages = options.persistedMessages || (options.taskSessionId ? await listAgentMessages(options.taskSessionId) : []);
  const projectMemoryPrompt = options.projectMemoryPrompt ?? (await loadProjectMemoryPrompt());
  const messages = restoreRuntimeMessages(options.userRequest, mode, persistedMessages, options.workflow, projectMemoryPrompt);
  const agentContext = options.agentContext || options.pendingToolCall.agentContext || createDefaultAgentContext(options.userRequest);
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
      : toModelToolMessage(await executeAgentToolCall(toAgentToolCall(createToolCallFromPending(options.pendingToolCall)), toolRuntime));

  messages.push(toolMessage);
  await persistAgentMessage(options.taskSessionId, toolMessage);

  return runAgentRuntime({
    ...options,
    mode,
    runId,
    registry,
    projectMemoryPrompt,
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
  const registry = options.registry || getAgentModeConfig(options.workflow?.type === "analysis-only" ? "plan" : mode).registry;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const providerId = options.providerId || "openai-compatible";
  const modelId = options.modelId || config.aiModel;
  const completeModel: (request: ModelRequest) => Promise<ModelResponse> = options.completeModel || (async (request: ModelRequest) => {
    if (options.requestCompletion) {
      const response = await options.requestCompletion(toOpenAiChatCompletionBody(request));
      return normalizeInjectedCompletion(response);
    }
    if (config.featureFlags.modelProviderGateway && implementedFeatures.modelProviderGateway) {
      return providerGateway.complete(
        { providerId, modelId },
        { messages: request.messages, temperature: request.temperature, tools: request.tools, toolChoice: request.toolChoice },
        options.signal
      );
    }
    const providerBody = toOpenAiChatCompletionBody(request);
    const response = await requestChatCompletion(providerBody) as AgentCompletionResponse;
    return normalizeInjectedCompletion(response);
  });
  // 测试、离线评测和受控调用方注入模型实现时，不应再要求其注册生产 Provider。
  const selectedModelDescriptor = options.modelDescriptor || (!options.completeModel && !options.requestCompletion && config.featureFlags.modelProviderGateway && implementedFeatures.modelProviderGateway
    ? await providerGateway.assertCompatible({ providerId, modelId }, mode === "act" ? "act" : "plan")
    : undefined);
  const agentContext = options.agentContext || createDefaultAgentContext(options.userRequest);
  const projectMemoryPrompt = options.projectMemoryPrompt ?? (await loadProjectMemoryPrompt());
  const messages: ModelMessage[] = options.messages ? [...options.messages] : createInitialMessages(options.userRequest, mode, options.workflow, projectMemoryPrompt);
  messages.forEach((message, index) => {
    message.id ??= `runtime-${runId}-${index + 1}`;
    message.createdAt ??= Date.now() + index;
  });
  if (!options.messages && options.taskSessionId) {
    // 初始系统规则和用户目标也进入原始审计链；压缩只改变发送视图，不删除这些记录。
    for (const message of messages) await persistAgentMessage(options.taskSessionId, message);
  }
  const generatedPatchIds = options.generatedPatchIds || [];
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, generatedPatchIds, taskSessionId: options.taskSessionId, onAgentStep: options.onAgentStep, registry, emitToolApprovalSteps: false });
  const toolCallCounts = new Map<string, number>();
  const repeatedToolWarnings = new Set<string>();
  let budgetWarningSent = false;
  let latestContextBudgetSnapshot: ContextBudgetSnapshot | undefined;
  let latestContextSummary: StructuredContextSummary | null = null;
  const contextBudgetEnabled = options.contextBudgetEnabled ?? (config.featureFlags.contextBudgetV2 && implementedFeatures.contextBudgetV2);
  const metrics = new RunMetricsTracker(
    {
      runId,
      taskSessionId: options.taskSessionId ?? null,
      provider: providerId,
      model: modelId,
      mode
    },
    options.metricsRecorder
  );
  metrics.setPrice(selectedModelDescriptor?.price);

  logAi(runId, "runtime.start", { userGoal: agentContext.userGoal, mode, maxSteps, tools: registry.definitions.map((tool) => tool.name) });

  try {
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
    const fullModelRequest: ModelRequest = {
      model: modelId,
      temperature: config.aiChatTemperature,
      messages,
      tools: registry.schemas,
      toolChoice: "auto"
    };
    let modelRequest = fullModelRequest;
    if (contextBudgetEnabled) {
      const taskContextState = await loadRuntimeContextState(options.taskSessionId);
      latestContextSummary ??= taskContextState.contextSummary;
      const prepared = prepareContextBudget({
        messages: fullModelRequest.messages,
        tools: fullModelRequest.tools,
        agentContext,
        planStatus: taskContextState.planStatus.length ? taskContextState.planStatus : options.workflow?.steps.map((workflowStep) => `pending: ${workflowStep.title}`),
        filesModified: taskContextState.filesModified,
        unresolvedQuestions: taskContextState.unresolvedQuestions,
        options: {
          contextWindowTokens: options.contextWindowTokens ?? selectedModelDescriptor?.capabilities.contextWindowTokens ?? config.aiContextWindowTokens,
          reservedOutputTokens: options.maxOutputTokens ?? selectedModelDescriptor?.capabilities.maxOutputTokens ?? config.aiMaxOutputTokens,
          safetyMarginTokens: options.contextSafetyMarginTokens ?? config.aiContextSafetyMarginTokens
        }
      });
      latestContextBudgetSnapshot = prepared.snapshot;
      latestContextSummary = prepared.summary ?? latestContextSummary;
      modelRequest = { ...fullModelRequest, messages: prepared.messages };
      metrics.recordContextEstimate(prepared.snapshot.estimatedInputTokensBeforeCompression, prepared.snapshot.estimatedInputTokensAfterCompression, prepared.snapshot.automaticCompression);
      // 每次都传播当前有效摘要，避免新 Runtime 丢失上一次压缩状态或保留已经清理的审批。
      await recordTaskSessionContextBudget(options.taskSessionId, prepared.snapshot, latestContextSummary);
      options.onContextBudget?.({ snapshot: prepared.snapshot, summary: latestContextSummary });
      logAi(runId, "runtime.contextBudget", {
        step,
        before: prepared.snapshot.estimatedInputTokensBeforeCompression,
        after: prepared.snapshot.estimatedInputTokensAfterCompression,
        available: prepared.snapshot.availableInputTokens,
        compressed: prepared.snapshot.automaticCompression
      });
    } else {
      const estimator = new ConservativeTokenEstimator();
      metrics.recordContextEstimate(estimator.estimateMessages(fullModelRequest.messages) + estimator.estimateValue(fullModelRequest.tools ?? []));
    }
    const completionStartedAt = Date.now();
    const completion = await completeModel(modelRequest);
    metrics.recordFirstTokenLatency(
      completion.firstTokenLatencyMs ?? Date.now() - completionStartedAt,
      completion.firstTokenLatencyMs === undefined ? "completion_upper_bound" : "provider"
    );
    metrics.addUsage(completion.usage);
    const message = completion.message;
    const toolCalls = message.toolCalls ?? [];

    if (!toolCalls.length) {
      const content = message.content || "";
      const assistantMessage: ModelMessage = { role: "assistant", content };
      messages.push(assistantMessage);
      await persistAgentMessage(options.taskSessionId, assistantMessage);
      options.onAgentStep?.(createAgentStep({ type: "message", content: content || "Agent runtime completed without text output." }));
      logAi(runId, "runtime.done", { step, mode, contentLength: content.length });
      await metrics.finish({ status: "completed", patchFileCount: countGeneratedPatchFiles(generatedPatchIds) });
      return {
        status: "completed",
        runId,
        content,
        messages,
        agentContext,
        generatedPatchIds,
        pendingToolCall: null,
        contextBudgetSnapshot: latestContextBudgetSnapshot,
        contextSummary: latestContextSummary
      };
    }

    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: message.content || null,
      toolCalls
    };
    messages.push(assistantMessage);
    await persistAgentMessage(options.taskSessionId, assistantMessage);

    logAi(runId, "runtime.toolCalls", toolCalls.map((toolCall) => toolCall.name));
    const repeatedToolNames: string[] = [];

    for (const toolCall of toolCalls) {
      const signature = getToolCallSignature(toolCall);
      const nextCount = (toolCallCounts.get(signature) || 0) + 1;
      toolCallCounts.set(signature, nextCount);
      metrics.recordToolCall({ repeated: nextCount > 1 });

      if (nextCount >= REPEATED_TOOL_CALL_WARNING_THRESHOLD && !repeatedToolWarnings.has(signature)) {
        repeatedToolWarnings.add(signature);
        repeatedToolNames.push(toolCall.name);
      }
    }

    for (const toolCall of toolCalls) {
      const definition = registry.get(toolCall.name);
      const workflowBlockReason = getWorkflowToolBlockReason(toolCall.name, agentContext, options.workflow);
      const patternFinderBlockReason = getPatternFinderBlockReason(toolCall.name, agentContext, registry);
      const existenceCheckBlockReason = getExistenceCheckBlockReason(toolCall.name, agentContext, registry);

      if (workflowBlockReason) {
        metrics.recordToolFailure();
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: workflowBlockReason, workflow: options.workflow?.type });
        options.onAgentStep?.(createAgentStep({ type: "error", message: workflowBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, workflowBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      if (patternFinderBlockReason) {
        metrics.recordToolFailure();
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: patternFinderBlockReason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: patternFinderBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, patternFinderBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      if (existenceCheckBlockReason) {
        metrics.recordToolFailure();
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: existenceCheckBlockReason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: existenceCheckBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, existenceCheckBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      const approval = evaluateAgentToolApproval(toAgentToolCall(toolCall), definition);

      if (approval.status === "blocked") {
        metrics.recordToolFailure();
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: approval.reason });
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
          toolName: toolCall.name,
          arguments: toolCall.arguments,
          riskLevel: approval.riskLevel,
          status: "pending",
          createdAt: Date.now(),
          agentContext: snapshotAgentContext(agentContext)
        };

        await setPendingAgentToolCall(options.taskSessionId, pendingToolCall);
        if (contextBudgetEnabled && latestContextBudgetSnapshot) {
          const taskContextState = await loadRuntimeContextState(options.taskSessionId);
          latestContextSummary = createStructuredContextSummary({
            messages,
            coveredMessageIds: latestContextSummary?.coveredMessageIds ?? [],
            agentContext,
            pendingToolCall,
            planStatus: taskContextState.planStatus,
            filesModified: taskContextState.filesModified,
            unresolvedQuestions: taskContextState.unresolvedQuestions
          });
          await recordTaskSessionContextBudget(options.taskSessionId, latestContextBudgetSnapshot, latestContextSummary);
          options.onContextBudget?.({ snapshot: latestContextBudgetSnapshot, summary: latestContextSummary });
        }
        logAi(runId, "runtime.awaitingApproval", { toolName: pendingToolCall.toolName, actionId: pendingToolCall.actionId });
        await metrics.finish({ status: "awaiting_approval", patchFileCount: countGeneratedPatchFiles(generatedPatchIds) });

        return {
          status: "awaiting_approval",
          runId,
          content: `Waiting for approval to run ${pendingToolCall.toolName}.`,
          messages,
          agentContext,
          generatedPatchIds,
          pendingToolCall,
          contextBudgetSnapshot: latestContextBudgetSnapshot,
          contextSummary: latestContextSummary
        };
      }

      try {
        const result = toModelToolMessage(await executeAgentToolCall(toAgentToolCall(toolCall), toolRuntime));
        if (typeof result.content === "string" && /\"error\"\s*:/.test(result.content)) metrics.recordToolFailure();
        messages.push(result);
        await persistAgentMessage(options.taskSessionId, result);
      } catch (error) {
        metrics.recordToolFailure();
        throw error;
      }
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
  await metrics.finish({ status: "step_limit_reached", failureCategory: "step_limit", patchFileCount: countGeneratedPatchFiles(generatedPatchIds) });

  return {
    status: "step_limit_reached",
    runId,
    content,
    messages,
    agentContext,
    generatedPatchIds,
    pendingToolCall: null,
    contextBudgetSnapshot: latestContextBudgetSnapshot,
    contextSummary: latestContextSummary
  };
  } catch (error) {
    await metrics.finish({ status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed", failureCategory: classifyRunFailure(error), patchFileCount: countGeneratedPatchFiles(generatedPatchIds) });
    throw error;
  }
}
