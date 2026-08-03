import crypto from "node:crypto";
import {
  getCreateIntentSearchBlockReason,
  getSearchScope,
  normalizeSearchTarget,
  promoteCreateIntentFacts
} from "./agentCreationPolicy.js";
import { appendAgentMessage, listAgentMessages, setPendingAgentToolCall } from "./agentMessageStore.js";
import {
  filterToolSchemasForBudgetPhase,
  getAgentBudgetPhase,
  isToolAvailableInBudgetPhase,
  normalizeRuntimeAgentBudgetPolicy,
  type AgentBudgetPhase
} from "./agentBudgetPolicy.js";
import { getAgentModeConfig, normalizeAgentMode, type AgentMode } from "./agentModes.js";
import {
  createCompletionRecoveryMessage,
  evaluateAgentCompletion,
  type CompletionEvidence
} from "./agentCompletionPolicy.js";
import { evaluateAgentToolApproval } from "./agentPermissions.js";
import type { AgentToolRegistry } from "./agentToolRegistry.js";
import type { AgentCompletionResponse, AgentContext, AgentProgressSnapshot, AgentToolCall } from "./agentToolTypes.js";
import { createAgentToolRuntime, executeAgentToolCall } from "./agentTools.js";
import { createAiRunId, logAi, requestChatCompletion } from "./aiHttp.js";
import { config } from "./config.js";
import { createAgentStep } from "./routeAgentSteps.js";
import type { AgentMessage as PersistedAgentMessage, AgentRuntimeStatus, AgentStep, PendingAgentToolCall, TaskPlanItem, TaskRuntimeEvidence } from "./types.js";
import {
  buildTaskWorkflowProgressPrompt,
  buildTaskWorkflowRuntimePrompt,
  classifyTaskWorkflow,
  evaluateTaskWorkflowToolDecision,
  evaluateWorkflowEditGate,
  parseReferenceCheckKey,
  resolveWorkflowEditIntent,
  cloneReferenceChecks,
  type TaskWorkflowDecision,
  type TaskWorkflowSnapshot
} from "./taskWorkflow/index.js";
import { getRelevantProjectMemoryPrompt } from "./projectMemory/index.js";
import { adaptOpenAiCompletionResponse, toOpenAiChatCompletionBody, type ModelDescriptor, type ModelMessage, type ModelRequest, type ModelResponse, type ModelToolCall } from "./contracts/index.js";
import { RunMetricsTracker, classifyRunFailure, type RunMetricsRecorder } from "./observability/index.js";
import { getPendingPatch } from "./patchStore.js";
import { ConservativeTokenEstimator, prepareContextBudget } from "./contextBudget/index.js";
import type { ContextBudgetSnapshot, StructuredContextSummary } from "./contracts/context.js";
import { implementedFeatures, recordFeatureDecisionDifference, resolveExplicitCompletionRollout, type ExplicitCompletionRolloutConfig } from "./featureFlags.js";
import { getTaskSessionContextState, recordTaskSessionContextBudget, setTaskSessionRuntimeEvidence } from "./taskSessionStore.js";
import { createStructuredContextSummary } from "./contextBudget/summary.js";
import { providerGateway } from "./providers/index.js";
import { parseCompleteTaskInput, type CompleteTaskInput } from "./agentCompletionTools.js";

export type AgentRuntimeResult = {
  status: AgentRuntimeStatus;
  runId: string;
  content: string;
  messages: ModelMessage[];
  agentContext: AgentContext;
  generatedPatchIds: string[];
  runtimeEvidence: TaskRuntimeEvidence;
  pendingToolCall?: PendingAgentToolCall | null;
  contextBudgetSnapshot?: ContextBudgetSnapshot;
  contextSummary?: StructuredContextSummary | null;
  completionEvidence?: CompletionEvidence;
  statusReason?: string;
  requestedStatus?: AgentRuntimeStatus;
};

export type AgentRuntimeOptions = {
  userRequest: string;
  messages?: ModelMessage[];
  agentContext?: AgentContext;
  registry?: AgentToolRegistry;
  maxSteps?: number;
  convergenceRemainingSteps?: number;
  forceFinalRemainingSteps?: number;
  runId?: string;
  generatedPatchIds?: string[];
  appliedFilePaths?: string[];
  runtimeEvidence?: TaskRuntimeEvidence;
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
  /** 仅供离线验收覆盖灰度阶段；生产默认读取集中配置。 */
  explicitCompletionRollout?: ExplicitCompletionRolloutConfig;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  contextSafetyMarginTokens?: number;
  // 受控评测可覆盖阈值；生产默认读取集中配置。
  maxNoProgressSteps?: number;
  recoveryAttempts?: number;
  modelDescriptor?: ModelDescriptor;
  signal?: AbortSignal;
  onContextBudget?: (event: { snapshot: ContextBudgetSnapshot; summary: StructuredContextSummary | null }) => void;
};

async function loadRuntimeContextState(taskSessionId: string | null | undefined) {
  if (!taskSessionId) return { planStatus: [] as string[], planItems: [] as TaskPlanItem[], filesModified: [] as string[], unresolvedQuestions: [] as string[], contextSummary: null as StructuredContextSummary | null, pendingToolCall: null as PendingAgentToolCall | null, runtimeEvidence: undefined as TaskRuntimeEvidence | undefined };
  try {
    const session = await getTaskSessionContextState(taskSessionId);
    return {
      planStatus: [
        ...(session.planItems ?? []).map((item) => `${item.status}: ${item.title}${item.note ? `（${item.note}）` : ""}`),
        `approval: ${session.planApproval?.status ?? "not_required"}`
      ],
      planItems: session.planItems ?? [],
      filesModified: [...session.filesChanged],
      unresolvedQuestions: (session.planItems ?? []).filter((item) => item.status === "blocked").map((item) => item.note || item.title),
      contextSummary: session.contextSummary ?? null,
      pendingToolCall: session.pendingToolCall ?? null,
      runtimeEvidence: session.runtimeEvidence
    };
  } catch {
    // 无持久化任务的单元调用继续使用 Runtime 内存状态。
    return { planStatus: [] as string[], planItems: [] as TaskPlanItem[], filesModified: [] as string[], unresolvedQuestions: [] as string[], contextSummary: null as StructuredContextSummary | null, pendingToolCall: null as PendingAgentToolCall | null, runtimeEvidence: undefined as TaskRuntimeEvidence | undefined };
  }
}

function createDefaultAgentContext(userRequest: string): AgentContext {
  return {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: [],
    negativeEvidence: [],
    createIntents: [],
    patternSearchPerformed: false,
    patternCandidateFiles: [],
    existenceCheckPerformed: false,
    unresolvedExistenceChecks: [],
    referenceChecks: {},
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
    negativeEvidence: agentContext.negativeEvidence ? agentContext.negativeEvidence.map((evidence) => ({ ...evidence })) : undefined,
    createIntents: agentContext.createIntents ? agentContext.createIntents.map((intent) => ({ ...intent })) : undefined,
    patternCandidateFiles: agentContext.patternCandidateFiles ? [...agentContext.patternCandidateFiles] : undefined,
    unresolvedExistenceChecks: agentContext.unresolvedExistenceChecks ? [...agentContext.unresolvedExistenceChecks] : undefined,
    referenceChecks: cloneReferenceChecks(agentContext.referenceChecks),
    impactAnalyses: agentContext.impactAnalyses ? structuredClone(agentContext.impactAnalyses) : undefined,
    modificationPlan: agentContext.modificationPlan ? structuredClone(agentContext.modificationPlan) : undefined,
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

export function getModificationPlanBlockReason(toolName: string, toolArguments: Record<string, unknown>, agentContext: AgentContext) {
  const editingTools = new Set(["proposePatch", "replaceInFile", "writeFile"]);
  if (!editingTools.has(toolName)) return null;

  // proposePatch 可在同一次调用中声明 plannedChanges；具体路径和磁盘状态由工具执行前校验。
  if (toolName === "proposePatch" && Array.isArray(toolArguments.plannedChanges) && toolArguments.plannedChanges.length) return null;

  const plan = agentContext.modificationPlan;
  if (!plan?.files.length) {
    return "Before editing, declare every file path, change kind, and reason with proposePatch.plannedChanges or planFileChanges.";
  }

  const requestedPath = typeof toolArguments.filePath === "string"
    ? toolArguments.filePath.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()
    : "";
  if (requestedPath && !plan.files.some((file) => file.filePath.toLowerCase() === requestedPath)) {
    return `The edit target ${toolArguments.filePath} is not included in the current structured modification plan. Update planFileChanges first.`;
  }

  return null;
}

function getExistenceCheckBlockReason(
  toolName: string,
  toolArguments: Record<string, unknown>,
  agentContext: AgentContext,
  registry: AgentToolRegistry
) {
  const editingTools = new Set(["proposePatch", "replaceInFile", "writeFile"]);
  if (!editingTools.has(toolName) || !registry.get("checkExistence")) return null;
  if (agentContext.existenceCheckPerformed !== true) return "Before editing, call checkExistence to verify referenced imports, symbols, scripts, or directories.";
  const intent = resolveWorkflowEditIntent(toolName, toolArguments);
  if (intent && agentContext.referenceChecks) {
    return evaluateWorkflowEditGate({
      intent,
      agentContext,
      availableTools: new Set(registry.definitions.map((definition) => definition.name))
    })?.reason || null;
  }
  if (agentContext.unresolvedExistenceChecks?.length) return `Resolve missing or ambiguous references before editing: ${agentContext.unresolvedExistenceChecks.join(", ")}.`;
  return null;
}

function getWorkflowToolBlockReason(
  toolName: string,
  toolArguments: Record<string, unknown>,
  agentContext: AgentContext,
  availableTools: ReadonlySet<string>,
  workflow?: TaskWorkflowSnapshot
) {
  if (!workflow) return null;
  return evaluateTaskWorkflowToolDecision({ workflow, toolName, toolArguments, agentContext, availableTools });
}

function createWorkflowDecisionStep(
  workflow: TaskWorkflowSnapshot,
  toolName: string,
  toolArguments: Record<string, unknown>,
  agentContext: AgentContext,
  decision: TaskWorkflowDecision
) {
  const intent = resolveWorkflowEditIntent(toolName, toolArguments);
  if (!intent) return null;
  const references = Object.entries(agentContext.referenceChecks || {}).map(([key, resolution]) => {
    const target = parseReferenceCheckKey(key);
    return {
      target: target ? `${target.kind}:${target.value}` : key,
      status: resolution.status,
      blocking: resolution.blocking,
      reason: resolution.reason,
      resolvedPath: resolution.resolvedPath
    };
  });
  const plannedFiles = intent.changeKind === "create" && intent.filePath ? [intent.filePath] : [];

  return createAgentStep({
    type: "workflow_decision",
    workflowType: workflow.type,
    toolName,
    plannedFiles,
    references,
    blockingReferences: decision.blockingReferences,
    decision: decision.allowed ? "allowed" : "blocked",
    reason: decision.reason || undefined,
    recommendedTools: decision.recommendedTools,
    recoverable: decision.recoverable,
    // 没有自动恢复工具的阻塞需要用户或外部条件介入。
    requiresUserAction: !decision.allowed && !decision.recoverable
  });
}

async function loadProjectMemoryPrompt(userRequest: string, agentContext?: AgentContext) {
  const contextPaths = [...new Set([...(agentContext?.relevantFiles || []), ...(agentContext?.filesRead || []), ...(agentContext?.searchResultFiles || [])])];
  return getRelevantProjectMemoryPrompt({
    userRequest,
    contextPaths,
    plannedFiles: agentContext?.relevantFiles || []
  });
}

function createInitialMessages(userRequest: string, mode: AgentMode, workflow?: TaskWorkflowSnapshot, projectMemoryPrompt = "") {
  const modeConfig = getAgentModeConfig(workflow?.type === "analysis-only" ? "plan" : mode);
  const systemPrompt = [modeConfig.systemPrompt, workflow ? buildTaskWorkflowRuntimePrompt(workflow) : "", projectMemoryPrompt].filter(Boolean).join("\n\n");

  return [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content: userRequest }
  ];
}

function separateRuntimeSystemPrompt(messages: ModelMessage[], additionalSystemPrompts: Array<string | null | undefined> = []) {
  const systemParts = messages
    .filter((message) => message.role === "system" && message.content?.trim())
    .map((message) => message.content!.trim());

  return {
    systemPrompt: [...systemParts, ...additionalSystemPrompts.map((prompt) => prompt?.trim()).filter((prompt): prompt is string => Boolean(prompt))].join("\n\n"),
    conversationMessages: messages.filter((message) => message.role !== "system")
  };
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

function getLatestValidationAt(agentContext: AgentContext) {
  const finishedAt = (agentContext.commandsRun ?? [])
    .filter((command) => command.validation === true && typeof command.finishedAt === "number")
    .map((command) => command.finishedAt as number);
  return finishedAt.length ? Math.max(...finishedAt) : undefined;
}

function createTaskRuntimeEvidence(input: {
  taskRunId: string;
  generatedPatchIds: string[];
  directAppliedFiles: ReadonlySet<string>;
  lastMutationAt?: number;
  lastValidationAt?: number;
}): TaskRuntimeEvidence {
  return {
    taskRunId: input.taskRunId,
    appliedFilePaths: [...input.directAppliedFiles],
    generatedPatchIds: [...new Set(input.generatedPatchIds)],
    lastMutationAt: input.lastMutationAt,
    lastValidationAt: input.lastValidationAt
  };
}

const completionRelevantWorkflowSteps = new Set([
  "implement",
  "validate",
  "minimal-fix",
  "add-regression-test",
  "regression-validation",
  "refactor",
  "tests",
  "regression"
]);

async function collectCompletionEvidence(input: {
  taskSessionId?: string | null;
  workflowType: TaskWorkflowSnapshot["type"];
  mutationExpected: boolean;
  generatedPatchIds: string[];
  directAppliedFiles: ReadonlySet<string>;
  agentContext: AgentContext;
  validationAvailable: boolean;
  failedToolCallCount: number;
  lastMutationAt?: number;
  lastValidationAt?: number;
  pendingApprovalCount?: number;
}): Promise<CompletionEvidence> {
  const taskState = await loadRuntimeContextState(input.taskSessionId);
  const relevantPlanItems = taskState.planItems.filter((item) =>
    item.workflowStepId ? completionRelevantWorkflowSteps.has(item.workflowStepId) : true
  );

  const commands = input.agentContext.commandsRun ?? [];
  const validationCommands = commands.filter((command) => command.validation === true);
  const latestValidation = validationCommands
    .filter((command) => command.finishedAt !== undefined)
    .sort((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0))[0];
  const validationStatus: CompletionEvidence["validationStatus"] = !input.mutationExpected
    ? "not_required"
    : !input.validationAvailable
      ? "unavailable"
      : !latestValidation
        ? "not_run"
        : latestValidation.status === "success"
          ? "passed"
          : "failed";

  return {
    workflowType: input.workflowType,
    mutationExpected: input.mutationExpected,
    generatedPatchCount: new Set(input.generatedPatchIds).size,
    // 会话中的 filesChanged 是跨多轮累积历史，不能作为本轮完成证据，否则后续零变更轮次会被误判成功。
    changedFileCount: new Set(input.directAppliedFiles).size,
    pendingPlanCount: relevantPlanItems.filter((item) => item.status === "pending" || item.status === "in_progress").length,
    blockedPlanCount: relevantPlanItems.filter((item) => item.status === "blocked").length,
    validationStatus,
    pendingApprovalCount: Math.max(input.pendingApprovalCount ?? 0, taskState.pendingToolCall ? 1 : 0),
    activeCommandCount: commands.filter((command) => command.status === "running").length,
    failedToolCallCount: input.failedToolCallCount,
    lastMutationAt: input.lastMutationAt,
    lastValidationAt: Math.max(input.lastValidationAt ?? 0, latestValidation?.finishedAt ?? 0) || undefined
  };
}

async function createProgressSnapshot(
  agentContext: AgentContext,
  generatedPatchIds: string[],
  taskSessionId?: string | null,
  readScopes: ReadonlySet<string> = new Set()
): Promise<AgentProgressSnapshot> {
  const taskState = await loadRuntimeContextState(taskSessionId);
  const discoveredFiles = new Set([
    ...agentContext.searchResultFiles,
    ...agentContext.relevantFiles
  ]);

  return {
    discoveredFiles: discoveredFiles.size,
    filesRead: new Set([
      ...agentContext.filesRead.map((filePath) => `file:${filePath}`),
      ...readScopes
    ]).size,
    searchResults: new Set(agentContext.searchResultFiles).size,
    negativeEvidence: agentContext.negativeEvidence?.length ?? 0,
    generatedPatches: new Set(generatedPatchIds).size,
    modifiedFiles: new Set(taskState.filesModified).size,
    commandsRun: agentContext.commandsRun?.length ?? 0,
    completedWorkflowSteps: taskState.planStatus.filter((status) => status.startsWith("completed:")).length
  };
}

function getSuccessfulReadScope(toolCall: ModelToolCall) {
  if (!["readFile", "readFileChunk", "readFileRange"].includes(toolCall.name)) return null;
  const filePath = String(toolCall.arguments.filePath || "").trim();
  if (!filePath) return null;
  if (toolCall.name === "readFile") return `file:${filePath}`;
  return `${toolCall.name}:${filePath}:${String(toolCall.arguments.startLine ?? "")}:${String(toolCall.arguments.endLine ?? "")}`;
}

function hasAgentProgress(before: AgentProgressSnapshot, after: AgentProgressSnapshot) {
  return (Object.keys(before) as Array<keyof AgentProgressSnapshot>)
    .some((key) => after[key] > before[key]);
}

function buildRecoveryFacts(agentContext: AgentContext, generatedPatchIds: string[]) {
  const facts: string[] = [];
  if (agentContext.filesRead.length) {
    facts.push(`已读取文件：${[...new Set(agentContext.filesRead)].slice(0, 8).join("、")}`);
  }
  for (const evidence of (agentContext.negativeEvidence || []).filter((item) => item.exhaustive).slice(0, 6)) {
    facts.push(`已完整检查 ${evidence.scope}，未发现“${evidence.query}”`);
  }
  for (const intent of (agentContext.createIntents || []).slice(0, 6)) {
    facts.push(`目标“${intent.target}”不存在，已确认需要在 ${intent.scope} 创建`);
  }
  if (generatedPatchIds.length) facts.push(`已生成 ${new Set(generatedPatchIds).size} 个待审核补丁`);
  if (agentContext.commandsRun?.length) facts.push(`已运行 ${agentContext.commandsRun.length} 条命令`);
  return facts.length ? facts : ["此前的工具调用没有形成可复用的新事实"];
}

function createNoProgressRecoveryMessage(
  threshold: number,
  recoveryAttempt: number,
  agentContext: AgentContext,
  generatedPatchIds: string[]
): ModelMessage {
  const facts = buildRecoveryFacts(agentContext, generatedPatchIds).map((fact) => `- ${fact}`).join("\n");
  return {
    role: "user",
    content: `连续 ${threshold} 次工具调用没有获得新信息，正在执行第 ${recoveryAttempt} 次策略恢复。\n\n已确认：\n${facts}\n\n禁止重复此前的搜索或读取。请更换策略：优先读取尚未检查的精确入口文件、创建所需实现或补丁、运行必要验证；如果无法继续，请输出明确的阻塞原因。`
  };
}

function createNoProgressStopContent(
  threshold: number,
  recoveryAttempts: number,
  agentContext: AgentContext,
  generatedPatchIds: string[],
  diagnostics: {
    currentStep: number;
    maxSteps: number;
    toolCalls: number;
    repeatedCalls: number;
    primaryRepeatedTool?: ModelToolCall;
  }
) {
  const facts = buildRecoveryFacts(agentContext, generatedPatchIds).map((fact) => `- ${fact}`).join("\n");
  const primaryTool = diagnostics.primaryRepeatedTool;
  const queryTarget = primaryTool
    ? String(primaryTool.arguments.query || primaryTool.arguments.filePath || primaryTool.arguments.path || "").trim()
    : "";
  return [
    "智能体因连续工具调用未取得进展而停止。",
    "",
    `模型轮次：${diagnostics.currentStep}/${diagnostics.maxSteps}`,
    `工具调用：${diagnostics.toolCalls}`,
    `重复调用：${diagnostics.repeatedCalls}`,
    `连续无进展调用：${threshold}`,
    `已执行策略恢复：${recoveryAttempts} 次`,
    primaryTool ? `主要重复工具：${primaryTool.name}` : "",
    queryTarget ? `查询目标：${queryTarget}` : "",
    `已确认：\n${facts}`,
    "建议下一步：复用以上事实创建缺失实现或缩小目标范围，并运行必要验证。"
  ].filter(Boolean).join("\n");
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

function analyzeToolResult(content: ModelMessage["content"]) {
  if (typeof content !== "string") return { cached: false, empty: false, failed: false };

  try {
    const value = JSON.parse(content) as unknown;
    if (value === null || value === "") return { cached: false, empty: true, failed: false };
    if (Array.isArray(value)) return { cached: false, empty: value.length === 0, failed: false };
    if (!value || typeof value !== "object") return { cached: false, empty: false, failed: false };

    const record = value as Record<string, unknown>;
    const cached = record.cached === true || (typeof record.note === "string" && record.note.includes("already called with these arguments"));
    const failed = typeof record.error === "string";
    // 缓存包装和搜索工具都使用这些集合字段；只判断明确存在的空集合，避免把普通对象误报为空结果。
    const collection = ["results", "matches", "files", "items"]
      .map((key) => record[key])
      .find((entry) => Array.isArray(entry));
    return { cached, empty: Array.isArray(collection) && collection.length === 0, failed };
  } catch {
    return { cached: false, empty: false, failed: false };
  }
}

function getSafeEditorMetricDelta(content: ModelMessage["content"]) {
  if (typeof content !== "string") return null;
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    const telemetry = value?.safeEditTelemetry;
    if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) return null;
    const metrics = telemetry as Record<string, unknown>;
    const count = (key: string) => typeof metrics[key] === "number" ? Math.max(0, Math.floor(metrics[key] as number)) : 0;
    return {
      safeEditorNeedsAnalysisCount: count("needsAnalysisCount"),
      safeEditorAutoAnalysisAttemptCount: count("autoAnalysisAttemptCount"),
      safeEditorAutoAnalysisSuccessCount: count("autoAnalysisSuccessCount"),
      safeEditorConfirmedExpansionCount: count("confirmedExpansionCount"),
      safeEditorRiskAcknowledgementCount: count("riskAcknowledgementCount"),
      safeEditorFalseExpansionRegressionCount: count("falseExpansionRegressionCount")
    };
  } catch {
    return null;
  }
}

function getAppliedFileEvidence(content: ModelMessage["content"]) {
  if (typeof content !== "string") return { paths: [] as string[], mutationConfirmed: false };

  try {
    const root = JSON.parse(content) as unknown;
    const candidates = [root];
    if (root && typeof root === "object" && !Array.isArray(root)) {
      const record = root as Record<string, unknown>;
      candidates.push(record.value, record.result);
    }

    const files = new Set<string>();
    let mutationConfirmed = false;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      if (record.changed !== true && record.applied !== true) continue;
      mutationConfirmed = true;
      if (typeof record.filePath === "string" && record.filePath.trim()) files.add(record.filePath.trim());
      if (Array.isArray(record.files)) {
        for (const file of record.files) {
          if (typeof file === "string" && file.trim()) files.add(file.trim());
        }
      }
    }
    return { paths: [...files], mutationConfirmed };
  } catch {
    return { paths: [] as string[], mutationConfirmed: false };
  }
}

function getAppliedPatchFilePaths(content: ModelMessage["content"]) {
  if (typeof content !== "string") return [];

  try {
    const root = JSON.parse(content) as unknown;
    const candidates = [root];
    if (root && typeof root === "object" && !Array.isArray(root)) {
      const record = root as Record<string, unknown>;
      candidates.push(record.value, record.result);
    }

    const files = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const record = candidate as Record<string, unknown>;
      // applyPatch 的成功结果必须同时携带 patchId 和文件列表，避免仅凭调用参数伪造落盘证据。
      if (typeof record.patchId !== "string" || !Array.isArray(record.files)) continue;
      for (const file of record.files) {
        if (typeof file === "string" && file.trim()) {
          files.add(file.trim());
          continue;
        }
        if (!file || typeof file !== "object" || Array.isArray(file)) continue;
        const fileRecord = file as Record<string, unknown>;
        const filePath = typeof fileRecord.path === "string" ? fileRecord.path : fileRecord.filePath;
        if (typeof filePath === "string" && filePath.trim()) files.add(filePath.trim());
      }
    }
    return [...files];
  } catch {
    return [];
  }
}

function getConfirmedAppliedFilePaths(toolName: string, content: ModelMessage["content"], argumentsRecord: Record<string, unknown>) {
  if (toolName === "applyPatch") return getAppliedPatchFilePaths(content);

  const evidence = getAppliedFileEvidence(content);
  // 自定义修复工具只要明确返回 applied/changed 与文件路径，也属于可审计的落盘证据。
  if (evidence.paths.length) return evidence.paths;
  if (!["replaceInFile", "writeFile"].includes(toolName)) return [];
  if (!evidence.mutationConfirmed) return [];

  const filePath = String(argumentsRecord.filePath || "").trim();
  return filePath ? [filePath] : [];
}

function buildNegativeEvidenceMessage(agentContext: AgentContext): ModelMessage | null {
  const evidence = (agentContext.negativeEvidence || []).filter((item) => item.exhaustive);
  if (!evidence.length) return null;

  const facts = evidence.map((item) => {
    const targetLabel = item.kind === "path_absent" ? "路径或文件" : item.kind === "symbol_absent" ? "符号" : "文本";
    return `- 已完整检查 ${item.scope}，未发现${targetLabel}“${item.query}”（来源：${item.sourceTool}）。`;
  });

  const createIntentKeys = new Set(
    (agentContext.createIntents || []).map((intent) => `${intent.scope}:${normalizeSearchTarget(intent.target)}`)
  );
  const creationFacts = evidence
    .filter((item) => createIntentKeys.has(`${item.scope}:${normalizeSearchTarget(item.query)}`))
    .map((item) => `- 目标“${item.query}”不存在，已确认需要创建；停止继续搜索同名或同职责目标，下一步构建文件计划并调用 proposePatch 或 writeFile(createIfMissing=true)。`);

  return {
    role: "user",
    content: [
      `以下是本轮已经确认的负面证据：\n${facts.join("\n")}`,
      creationFacts.length ? `创建策略事实：\n${creationFacts.join("\n")}` : "",
      "请复用这些事实，判断是否需要创建目标实现或调整方案，不要重复搜索相同范围。"
    ].filter(Boolean).join("\n")
  };
}

function createCreateIntentSearchBlockedMessage(toolCall: ModelToolCall, reason: string): ModelMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: JSON.stringify({
      error: "create_intent_search_blocked",
      toolName: toolCall.name,
      instruction: reason
    })
  };
}

function createToolBudgetWarningMessage(remainingSteps: number, hasGeneratedPatch: boolean): ModelMessage {
  const instruction = hasGeneratedPatch
    ? "已有待审核补丁。除非完成审批所必需，否则停止调用工具，并立即给出简洁的中文补丁说明。"
    : "禁止继续宽泛搜索。请复用已有证据，优先使用精确读取、proposePatch、必要的编辑或验证工具完成任务；如果无法完成，请明确说明已确认事实和未完成原因。";

  return {
    role: "user",
    content: `Agent 已进入预算收敛区间，仅剩 ${remainingSteps} 个模型步骤。${instruction}`
  };
}

function createForceFinalMessage(agentContext: AgentContext, generatedPatchIds: string[]): ModelMessage {
  const facts = buildRecoveryFacts(agentContext, generatedPatchIds);
  const patchInstruction = generatedPatchIds.length
    ? `已有 ${generatedPatchIds.length} 个待审核补丁，最终回答必须优先说明补丁内容和审核状态。`
    : "如果任务尚未完成，最终回答必须说明未完成原因和建议的下一步。";

  return {
    role: "user",
    content: [
      "这是最后的模型步骤，工具调用已被 Runtime 禁用。请立即输出可独立理解的中文最终结论。",
      patchInstruction,
      facts.length ? `已确认事实：\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "当前没有可补充的已确认事实。"
    ].join("\n")
  };
}

function createBudgetLimitContent(
  maxSteps: number,
  agentContext: AgentContext,
  generatedPatchIds: string[],
  reason: string
) {
  const facts = buildRecoveryFacts(agentContext, generatedPatchIds);
  return [
    `智能体已用完 ${maxSteps} 个模型步骤，Runtime 已停止新的工具调用。`,
    generatedPatchIds.length
      ? `已生成 ${generatedPatchIds.length} 个待审核补丁：${generatedPatchIds.join("、")}。`
      : "尚未生成待审核补丁。",
    facts.length ? `已确认事实：\n${facts.map((fact) => `- ${fact}`).join("\n")}` : "已确认事实：暂无可用的结构化事实。",
    `未完成原因：${reason}`
  ].join("\n");
}

function createBudgetBlockedToolMessage(toolCall: ModelToolCall, phase: AgentBudgetPhase): ModelMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: JSON.stringify({
      error: phase === "force_final" ? "force_final_tool_call_blocked" : "convergence_tool_call_blocked",
      toolName: toolCall.name,
      instruction: phase === "force_final"
        ? "工具预算已关闭，请直接输出最终结论。"
        : "预算已进入收敛区间，请复用已有搜索结果并改用精确读取、编辑、补丁或验证工具。"
    })
  };
}

function createRepeatedToolWarningMessage(toolNames: string[]): ModelMessage {
  return {
    role: "user",
    content: `You repeated these tool calls: ${toolNames.join(", ")}. Reuse the existing tool results instead of calling the same tool with the same arguments again. If enough context is available, move to proposePatch for a reviewable pending patch, use replaceInFile/writeFile only as the direct-edit fallback, or provide the final answer.`
  };
}

function createRepeatedToolCallBlockedMessage(toolCall: ModelToolCall, repeatCount: number): ModelMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: JSON.stringify({
      error: "repeated_tool_call_blocked",
      toolName: toolCall.name,
      repeatCount,
      cached: true,
      instruction: "该调用已经得到完整结果，请复用已有结果或更换策略。"
    })
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

function createCompletionToolErrorMessage(toolCall: ModelToolCall, reason: string, status: string = "incomplete"): ModelMessage {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    content: JSON.stringify({ error: reason, completionRequested: true, completionStatus: status })
  };
}

function createExplicitCompletionReminder(reason: string): ModelMessage {
  return {
    role: "user",
    content: [
      "Runtime 尚未收到显式完成声明，本轮不能结束。",
      `当前证据判断：${reason}`,
      "若任务已经完成，请将 completeTask 作为下一响应中的唯一工具调用；否则继续完成剩余工作。"
    ].join("\n")
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
  const projectMemoryPrompt = options.projectMemoryPrompt ?? (await loadProjectMemoryPrompt(options.userRequest, options.agentContext));
  const messages = restoreRuntimeMessages(options.userRequest, mode, persistedMessages, options.workflow, projectMemoryPrompt);
  const agentContext = options.agentContext || options.pendingToolCall.agentContext || createDefaultAgentContext(options.userRequest);
  const taskContextState = options.runtimeEvidence ? null : await loadRuntimeContextState(options.taskSessionId);
  const persistedRuntimeEvidence = options.runtimeEvidence ?? taskContextState?.runtimeEvidence;
  const generatedPatchIds = [...new Set([
    ...(persistedRuntimeEvidence?.generatedPatchIds ?? []),
    ...(options.generatedPatchIds ?? [])
  ])];
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
  const pendingArguments = options.pendingToolCall.arguments
    && typeof options.pendingToolCall.arguments === "object"
    && !Array.isArray(options.pendingToolCall.arguments)
    ? options.pendingToolCall.arguments as Record<string, unknown>
    : {};
  const appliedFilePaths = options.decision === "approved"
    ? getConfirmedAppliedFilePaths(options.pendingToolCall.toolName, toolMessage.content, pendingArguments)
    : [];
  const mergedAppliedFilePaths = [...new Set([
    ...(persistedRuntimeEvidence?.appliedFilePaths ?? []),
    ...(options.appliedFilePaths ?? []),
    ...appliedFilePaths
  ])];
  const approvalMutationAt = appliedFilePaths.length ? Date.now() : undefined;
  const runtimeEvidence = createTaskRuntimeEvidence({
    taskRunId: persistedRuntimeEvidence?.taskRunId ?? runId,
    generatedPatchIds,
    directAppliedFiles: new Set(mergedAppliedFilePaths),
    lastMutationAt: Math.max(persistedRuntimeEvidence?.lastMutationAt ?? 0, approvalMutationAt ?? 0) || undefined,
    lastValidationAt: Math.max(persistedRuntimeEvidence?.lastValidationAt ?? 0, getLatestValidationAt(agentContext) ?? 0) || undefined
  });

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
    generatedPatchIds,
    appliedFilePaths: mergedAppliedFilePaths,
    runtimeEvidence
  });
}

/**
 * 连续 Agent Runtime：由模型决定下一步工具调用，服务端执行后把结果回填给模型。
 */
export async function runAgentRuntime(options: AgentRuntimeOptions): Promise<AgentRuntimeResult> {
  const runId = options.runId || createAiRunId("agent-runtime");
  const mode = normalizeAgentMode(options.mode);
  const registry = options.registry || getAgentModeConfig(options.workflow?.type === "analysis-only" ? "plan" : mode).registry;
  const explicitCompletionRollout = resolveExplicitCompletionRollout({
    taskKey: options.taskSessionId || runId,
    featureEnabled: config.featureFlags.explicitCompletionTool,
    implementationAvailable: implementedFeatures.explicitCompletionTool,
    toolRegistered: Boolean(registry.get("completeTask")),
    config: options.explicitCompletionRollout ?? config.explicitCompletionRollout
  });
  const explicitCompletionToolEnabled = explicitCompletionRollout.toolAvailable;
  const explicitCompletionRequired = explicitCompletionRollout.enforceExplicitCompletion;
  const budgetPolicy = normalizeRuntimeAgentBudgetPolicy({
    maxSteps: options.maxSteps ?? config.aiAgentMaxSteps,
    convergenceRemainingSteps: options.convergenceRemainingSteps ?? config.aiAgentConvergenceRemainingSteps,
    forceFinalRemainingSteps: options.forceFinalRemainingSteps ?? config.aiAgentForceFinalRemainingSteps
  });
  const maxSteps = budgetPolicy.maxSteps;
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
        { systemPrompt: request.systemPrompt, messages: request.messages, temperature: request.temperature, tools: request.tools, toolChoice: request.toolChoice },
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
  const projectMemoryPrompt = options.projectMemoryPrompt ?? (await loadProjectMemoryPrompt(options.userRequest, agentContext));
  const messages: ModelMessage[] = options.messages ? [...options.messages] : createInitialMessages(options.userRequest, mode, options.workflow, projectMemoryPrompt);
  messages.forEach((message, index) => {
    message.id ??= `runtime-${runId}-${index + 1}`;
    message.createdAt ??= Date.now() + index;
  });
  if (!options.messages && options.taskSessionId) {
    // 初始系统规则和用户目标也进入原始审计链；压缩只改变发送视图，不删除这些记录。
    for (const message of messages) await persistAgentMessage(options.taskSessionId, message);
  }
  const taskContextState = options.runtimeEvidence ? null : await loadRuntimeContextState(options.taskSessionId);
  const restoredRuntimeEvidence = options.runtimeEvidence ?? taskContextState?.runtimeEvidence;
  const taskRunId = restoredRuntimeEvidence?.taskRunId ?? runId;
  const generatedPatchIds = [...new Set([
    ...(restoredRuntimeEvidence?.generatedPatchIds ?? []),
    ...(options.generatedPatchIds ?? [])
  ])];
  const maxNoProgressSteps = Number.isInteger(options.maxNoProgressSteps) && (options.maxNoProgressSteps ?? 0) > 0
    ? options.maxNoProgressSteps as number
    : config.aiAgentMaxNoProgressSteps;
  const allowedRecoveryAttempts = Number.isInteger(options.recoveryAttempts) && (options.recoveryAttempts ?? -1) >= 0
    ? options.recoveryAttempts as number
    : config.aiAgentRecoveryAttempts;
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, generatedPatchIds, taskSessionId: options.taskSessionId, onAgentStep: options.onAgentStep, registry, emitToolApprovalSteps: false });
  const toolCallCounts = new Map<string, number>();
  const toolCallsBySignature = new Map<string, ModelToolCall>();
  const repeatCountsByToolCall = new Map<ModelToolCall, number>();
  const repeatedToolWarnings = new Set<string>();
  let budgetWarningSent = false;
  let consecutiveNoProgressSteps = 0;
  let recoveryAttempts = 0;
  let completionRecoveryAttempted = false;
  const directAppliedFiles = new Set([
    ...(restoredRuntimeEvidence?.appliedFilePaths ?? []),
    ...(options.appliedFilePaths ?? [])
  ]);
  let lastMutationAt = restoredRuntimeEvidence?.lastMutationAt
    ?? (options.appliedFilePaths?.length ? Date.now() : undefined);
  let lastValidationAt = Math.max(restoredRuntimeEvidence?.lastValidationAt ?? 0, getLatestValidationAt(agentContext) ?? 0) || undefined;
  const snapshotRuntimeEvidence = () => createTaskRuntimeEvidence({
    taskRunId,
    generatedPatchIds,
    directAppliedFiles,
    lastMutationAt,
    lastValidationAt
  });
  const persistRuntimeEvidence = () => setTaskSessionRuntimeEvidence(options.taskSessionId, snapshotRuntimeEvidence());
  const workflowType = options.workflow?.type ?? classifyTaskWorkflow(options.userRequest).type;
  const mutationExpected = mode === "act" && workflowType !== "analysis-only";
  const workspaceMutationAuthorized = options.workflow?.authorization?.workspaceMutation ?? mutationExpected;
  promoteCreateIntentFacts(agentContext, { mode, workflowType, workspaceMutationAuthorized });
  const emittedNegativeEvidence = new Set(
    (agentContext.negativeEvidence || []).filter((item) => item.exhaustive)
      .map((item) => `${item.kind}:${item.scope}:${item.query}`)
  );
  const readScopes = new Set(agentContext.filesRead.map((filePath) => `file:${filePath}`));
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
      const budgetPhase = getAgentBudgetPhase(remainingSteps, budgetPolicy);
      const visibleToolSchemas = filterToolSchemasForBudgetPhase(registry.schemas, budgetPhase)
        .filter((schema) => explicitCompletionToolEnabled || schema.function.name !== "completeTask");
      const currentAvailableToolNames = new Set(visibleToolSchemas.map((schema) => schema.function.name));

    if (!budgetWarningSent && budgetPhase === "convergence") {
      const warningMessage = createToolBudgetWarningMessage(remainingSteps, generatedPatchIds.length > 0);
      messages.push(warningMessage);
      await persistAgentMessage(options.taskSessionId, warningMessage);
      budgetWarningSent = true;
      // 把预算预警写入步骤流，前端可直接展示“即将触达工具预算”的观测信号。
      options.onAgentStep?.(createAgentStep({
        type: "strategy",
        event: "budget_convergence",
        message: `剩余 ${remainingSteps} 个模型步骤，宽泛搜索工具已禁用。`,
        currentStep: step + 1,
        maxSteps
      }));
      logAi(runId, "runtime.budgetConvergence", { step, remainingSteps, generatedPatchIds, tools: [...currentAvailableToolNames] });
    }

    logAi(runId, "runtime.completion.request", { step, messageCount: messages.length });
    const negativeEvidenceMessage = buildNegativeEvidenceMessage(agentContext);
    const workflowProgressPrompt = options.workflow
      ? buildTaskWorkflowProgressPrompt(options.workflow, agentContext, currentAvailableToolNames)
      : null;
    const forceFinalMessage = budgetPhase === "force_final"
      ? createForceFinalMessage(agentContext, generatedPatchIds)
      : null;
    const transientDecisionMessages = [negativeEvidenceMessage, forceFinalMessage].filter((message): message is ModelMessage => Boolean(message));
    const separatedRequest = separateRuntimeSystemPrompt(messages, [workflowProgressPrompt]);
    const fullModelRequest: ModelRequest = {
      model: modelId,
      systemPrompt: separatedRequest.systemPrompt || undefined,
      temperature: config.aiChatTemperature,
      messages: transientDecisionMessages.length ? [...separatedRequest.conversationMessages, ...transientDecisionMessages] : separatedRequest.conversationMessages,
      tools: visibleToolSchemas,
      toolChoice: visibleToolSchemas.length ? "auto" : "none"
    };
    let modelRequest = fullModelRequest;
    if (contextBudgetEnabled) {
      const taskContextState = await loadRuntimeContextState(options.taskSessionId);
      latestContextSummary ??= taskContextState.contextSummary;
      const prepared = prepareContextBudget({
        messages: [
          ...(fullModelRequest.systemPrompt ? [{ role: "system" as const, content: fullModelRequest.systemPrompt }] : []),
          ...fullModelRequest.messages
        ],
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
      const separatedPrepared = separateRuntimeSystemPrompt(prepared.messages);
      modelRequest = {
        ...fullModelRequest,
        systemPrompt: separatedPrepared.systemPrompt || undefined,
        messages: separatedPrepared.conversationMessages
      };
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
      metrics.recordContextEstimate(estimator.estimateMessages([
        ...(fullModelRequest.systemPrompt ? [{ role: "system" as const, content: fullModelRequest.systemPrompt }] : []),
        ...fullModelRequest.messages
      ]) + estimator.estimateValue(fullModelRequest.tools ?? []));
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

    if (budgetPhase === "force_final" && toolCalls.length && !toolCalls.some((toolCall) => toolCall.name === "completeTask")) {
      // 即使 Provider 违反 toolChoice=none，最终轮也只记录越权尝试，不执行任何工具。
      for (const toolCall of toolCalls) {
        const signature = getToolCallSignature(toolCall);
        const nextCount = (toolCallCounts.get(signature) || 0) + 1;
        toolCallCounts.set(signature, nextCount);
        metrics.recordToolCall({
          toolName: toolCall.name,
          signature,
          step: step + 1,
          repeated: nextCount > 1,
          invalid: !registry.get(toolCall.name)
        });
        metrics.recordToolResult({ signature, noProgress: true });
      }
      const content = message.content?.trim() || createBudgetLimitContent(
        maxSteps,
        agentContext,
        generatedPatchIds,
        "模型在强制结论轮仍尝试调用工具，该调用已被硬性拦截。"
      );
      const assistantMessage: ModelMessage = { role: "assistant", content };
      messages.push(assistantMessage);
      await persistAgentMessage(options.taskSessionId, assistantMessage);
      options.onAgentStep?.(createAgentStep({
        type: "strategy",
        event: "budget_stop",
        message: content,
        currentStep: step + 1,
        maxSteps,
        facts: buildRecoveryFacts(agentContext, generatedPatchIds)
      }));
      options.onAgentStep?.(createAgentStep({ type: "error", message: content }));
      logAi(runId, "runtime.forceFinalToolCallBlocked", { step, toolNames: toolCalls.map((toolCall) => toolCall.name) });
      await metrics.finish({ status: "step_limit_reached", stopReason: "step_limit", failureCategory: "step_limit", patchFileCount: countGeneratedPatchFiles(generatedPatchIds) });
      await persistRuntimeEvidence();
      return {
        status: "step_limit_reached",
        runId,
        content,
        messages,
        agentContext,
        generatedPatchIds,
        runtimeEvidence: snapshotRuntimeEvidence(),
        pendingToolCall: null,
        contextBudgetSnapshot: latestContextBudgetSnapshot,
        contextSummary: latestContextSummary
      };
    }

    if (!toolCalls.length) {
      const content = message.content || "";
      const assistantMessage: ModelMessage = { role: "assistant", content };
      messages.push(assistantMessage);
      await persistAgentMessage(options.taskSessionId, assistantMessage);
      const evidence = await collectCompletionEvidence({
        taskSessionId: options.taskSessionId,
        workflowType,
        mutationExpected,
        generatedPatchIds,
        directAppliedFiles,
        agentContext,
        validationAvailable: Boolean(registry.get("runCommand")),
        failedToolCallCount: metrics.getCompletionEvidenceSnapshot().failedToolCallCount,
        lastMutationAt,
        lastValidationAt
      });
      const semanticCompletionDecision = evaluateAgentCompletion({
        evidence,
        finalContent: content,
        recoveryAttempted: completionRecoveryAttempted,
        editingToolsAvailable: registry.definitions.some((definition) =>
          ["proposePatch", "replaceInFile", "writeFile"].includes(definition.name)
        )
      });
      const legacyCompletionDecision = evidence.generatedPatchCount > 0
        ? { status: "awaiting_approval" as const, reason: "已生成待审核补丁。", shouldRecover: false }
        : { status: "completed" as const, reason: "模型已返回最终文本。", shouldRecover: false };
      recordFeatureDecisionDifference({
        feature: "semanticCompletionCheck",
        legacyDecision: { status: legacyCompletionDecision.status },
        nextDecision: { status: semanticCompletionDecision.status }
      });
      const completionDecision = config.featureFlags.semanticCompletionCheck
        ? semanticCompletionDecision
        : legacyCompletionDecision;

      const explicitCompletionDecision = completionDecision.status === "completed"
        ? {
            status: "incomplete" as const,
            reason: "模型自然停止，但没有调用 completeTask 请求结束。",
            shouldRecover: true
          }
        : completionDecision;
      if (explicitCompletionRollout.compareLegacyDecision) recordFeatureDecisionDifference({
        feature: "explicitCompletionTool",
        legacyDecision: { status: completionDecision.status },
        nextDecision: { status: explicitCompletionDecision.status }
      });
      const effectiveCompletionDecision = explicitCompletionRequired
        ? explicitCompletionDecision
        : completionDecision;

      if (effectiveCompletionDecision.shouldRecover && step + 1 < maxSteps) {
        const recoveryMessage = explicitCompletionRequired && completionDecision.status === "completed"
          ? createExplicitCompletionReminder(effectiveCompletionDecision.reason)
          : createCompletionRecoveryMessage(effectiveCompletionDecision, evidence);
        messages.push(recoveryMessage);
        await persistAgentMessage(options.taskSessionId, recoveryMessage);
        completionRecoveryAttempted = true;
        metrics.recordStrategyRecovery();
        options.onAgentStep?.(createAgentStep({
          type: "strategy",
          event: "completion_recovery",
          message: effectiveCompletionDecision.reason,
          currentStep: step + 1,
          maxSteps,
          facts: buildRecoveryFacts(agentContext, generatedPatchIds)
        }));
        logAi(runId, "runtime.completionRecovery", { step, status: effectiveCompletionDecision.status, evidence, explicitCompletionToolEnabled, explicitCompletionRequired, rolloutMode: explicitCompletionRollout.mode, rolloutBucket: explicitCompletionRollout.bucket });
        continue;
      }

      options.onAgentStep?.(createAgentStep({ type: "message", content: content || "Agent runtime completed without text output." }));
      logAi(runId, "runtime.done", { step, mode, contentLength: content.length, status: effectiveCompletionDecision.status, evidence });
      await metrics.finish({
        status: effectiveCompletionDecision.status,
        stopReason: effectiveCompletionDecision.status,
        failureCategory: "none",
        patchFileCount: countGeneratedPatchFiles(generatedPatchIds),
        validationCommandCount: agentContext.commandsRun?.filter((command) => command.validation === true).length ?? 0,
        validationStatus: evidence.validationStatus
      });
      await persistRuntimeEvidence();
      return {
        status: effectiveCompletionDecision.status,
        runId,
        content,
        messages,
        agentContext,
        generatedPatchIds,
        runtimeEvidence: snapshotRuntimeEvidence(),
        pendingToolCall: null,
        contextBudgetSnapshot: latestContextBudgetSnapshot,
        contextSummary: latestContextSummary,
        completionEvidence: evidence,
        statusReason: effectiveCompletionDecision.reason,
        // 模型请求结束不代表交付完成；保留“请求完成”与 Runtime 证据裁决后的有效状态。
        requestedStatus: "completed"
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
      toolCallsBySignature.set(signature, toolCall);
      repeatCountsByToolCall.set(toolCall, nextCount);
      metrics.recordToolCall({
        toolName: toolCall.name,
        signature,
        step: step + 1,
        repeated: nextCount > 1,
        invalid: !registry.get(toolCall.name)
      });

      if (nextCount >= config.aiAgentRepeatWarningThreshold && !repeatedToolWarnings.has(signature)) {
        repeatedToolWarnings.add(signature);
        repeatedToolNames.push(toolCall.name);
      }
    }

    const completionCalls = toolCalls.filter((toolCall) => toolCall.name === "completeTask");
    if (completionCalls.length) {
      const exclusive = toolCalls.length === 1 && completionCalls.length === 1;
      if (!explicitCompletionToolEnabled || !exclusive) {
        const reason = !explicitCompletionToolEnabled
          ? "completeTask is not enabled for this runtime."
          : "completeTask must be the only tool call in the assistant response; no other tool was executed.";
        for (const toolCall of toolCalls) {
          const errorMessage = createCompletionToolErrorMessage(toolCall, reason);
          messages.push(errorMessage);
          await persistAgentMessage(options.taskSessionId, errorMessage);
          metrics.recordToolFailure({ completionEvidence: false });
          metrics.recordToolResult({ signature: getToolCallSignature(toolCall), noProgress: true });
        }
        options.onAgentStep?.(createAgentStep({ type: "error", message: reason }));
        logAi(runId, "runtime.completeTaskRejected", { reason, toolNames: toolCalls.map((toolCall) => toolCall.name) });
        continue;
      }

      const completionCall = completionCalls[0];
      let completionInput: CompleteTaskInput;
      try {
        completionInput = parseCompleteTaskInput(completionCall.arguments);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Invalid completeTask arguments.";
        const errorMessage = createCompletionToolErrorMessage(completionCall, reason);
        messages.push(errorMessage);
        await persistAgentMessage(options.taskSessionId, errorMessage);
        metrics.recordToolFailure({ completionEvidence: false });
        metrics.recordToolResult({ signature: getToolCallSignature(completionCall), noProgress: true });
        logAi(runId, "runtime.completeTaskRejected", { reason });
        continue;
      }

      const evidence = await collectCompletionEvidence({
        taskSessionId: options.taskSessionId,
        workflowType,
        mutationExpected,
        generatedPatchIds,
        directAppliedFiles,
        agentContext,
        validationAvailable: Boolean(registry.get("runCommand")),
        failedToolCallCount: metrics.getCompletionEvidenceSnapshot().failedToolCallCount,
        lastMutationAt,
        lastValidationAt
      });
      const completionContent = [
        completionInput.summary,
        completionInput.validationSummary,
        ...(completionInput.unresolvedItems ?? [])
      ].filter(Boolean).join("\n");
      const evidenceDecision = evaluateAgentCompletion({
        evidence,
        finalContent: completionContent,
        recoveryAttempted: completionRecoveryAttempted,
        editingToolsAvailable: registry.definitions.some((definition) =>
          ["proposePatch", "replaceInFile", "writeFile"].includes(definition.name)
        )
      });
      const requestedDecision = completionInput.verified
        ? evidenceDecision
        : {
            status: (evidenceDecision.status === "blocked" || (completionInput.unresolvedItems?.length ?? 0) > 0 ? "blocked" : "incomplete") as "blocked" | "incomplete",
            reason: completionInput.unresolvedItems?.length
              ? "完成声明仍包含未解决事项。"
              : "完成声明明确标记为尚未验证。",
            shouldRecover: true
          };

      if (completionInput.verified && requestedDecision.status === "completed") {
        const toolResult = toModelToolMessage(await executeAgentToolCall(toAgentToolCall(completionCall), toolRuntime));
        messages.push(toolResult);
        await persistAgentMessage(options.taskSessionId, toolResult);
        metrics.recordToolResult({ signature: getToolCallSignature(completionCall), noProgress: false });
        options.onAgentStep?.(createAgentStep({ type: "message", content: completionInput.summary }));
        logAi(runId, "runtime.completeTaskAccepted", { step, evidence });
        await metrics.finish({
          status: "completed",
          stopReason: "completed",
          failureCategory: "none",
          patchFileCount: countGeneratedPatchFiles(generatedPatchIds),
          validationCommandCount: agentContext.commandsRun?.filter((command) => command.validation === true).length ?? 0,
          validationStatus: evidence.validationStatus
        });
        await persistRuntimeEvidence();
        return {
          status: "completed",
          runId,
          content: completionInput.summary,
          messages,
          agentContext,
          generatedPatchIds,
          runtimeEvidence: snapshotRuntimeEvidence(),
          pendingToolCall: null,
          contextBudgetSnapshot: latestContextBudgetSnapshot,
          contextSummary: latestContextSummary,
          completionEvidence: evidence,
          statusReason: evidenceDecision.reason,
          requestedStatus: "completed"
        };
      }

      const rejectionReason = `completeTask was rejected: ${requestedDecision.reason}`;
      const errorMessage = createCompletionToolErrorMessage(completionCall, rejectionReason, requestedDecision.status);
      messages.push(errorMessage);
      await persistAgentMessage(options.taskSessionId, errorMessage);
      metrics.recordToolFailure({ completionEvidence: false });
      metrics.recordToolResult({ signature: getToolCallSignature(completionCall), noProgress: true });
      options.onAgentStep?.(createAgentStep({ type: "error", message: rejectionReason }));
      logAi(runId, "runtime.completeTaskRejected", { reason: requestedDecision.reason, evidence });
      continue;
    }

    for (const toolCall of toolCalls) {
      const signature = getToolCallSignature(toolCall);
      const repeatCount = repeatCountsByToolCall.get(toolCall) ?? 1;

      // 第三次及后续完全相同的调用由 Runtime 直接拦截，但保留本轮其他工具继续执行。
      if (repeatCount >= config.aiAgentRepeatBlockThreshold) {
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        const blockedMessage = createRepeatedToolCallBlockedMessage(toolCall, repeatCount);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        options.onAgentStep?.(createAgentStep({
          type: "strategy",
          event: "repeated_tool_blocked",
          message: "相同参数的工具调用已获得完整结果，Runtime 已阻止再次执行。",
          toolName: toolCall.name,
          repeatCount,
          currentStep: step + 1,
          maxSteps
        }));
        logAi(runId, "runtime.repeatedToolCallBlocked", { toolName: toolCall.name, repeatCount });
        continue;
      }

      const definition = registry.get(toolCall.name);
      if (!isToolAvailableInBudgetPhase(toolCall.name, budgetPhase)) {
        metrics.recordToolFailure();
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        const blockedMessage = createBudgetBlockedToolMessage(toolCall, budgetPhase);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        logAi(runId, "runtime.budgetToolBlocked", { step, remainingSteps, budgetPhase, toolName: toolCall.name });
        continue;
      }
      const createIntentSearchBlockReason = getCreateIntentSearchBlockReason(toolCall, agentContext);
      if (createIntentSearchBlockReason) {
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        const blockedMessage = createCreateIntentSearchBlockedMessage(toolCall, createIntentSearchBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        options.onAgentStep?.(createAgentStep({
          type: "strategy",
          event: "create_intent_search_blocked",
          message: createIntentSearchBlockReason,
          toolName: toolCall.name,
          currentStep: step + 1,
          maxSteps,
          facts: buildRecoveryFacts(agentContext, generatedPatchIds)
        }));
        logAi(runId, "runtime.createIntentSearchBlocked", {
          step,
          toolName: toolCall.name,
          query: toolCall.arguments.query || toolCall.arguments.regex,
          scope: getSearchScope(toolCall)
        });
        continue;
      }
      const workflowDecision = getWorkflowToolBlockReason(toolCall.name, toolCall.arguments, agentContext, currentAvailableToolNames, options.workflow);
      const workflowBlockReason = workflowDecision?.reason || null;
      if (options.workflow && workflowDecision) {
        const decisionStep = createWorkflowDecisionStep(options.workflow, toolCall.name, toolCall.arguments, agentContext, workflowDecision);
        if (decisionStep) options.onAgentStep?.(decisionStep);
        if (resolveWorkflowEditIntent(toolCall.name, toolCall.arguments)) {
          logAi(runId, "runtime.workflowDecision", {
            workflowType: options.workflow.type,
            toolName: toolCall.name,
            plannedFiles: decisionStep?.type === "workflow_decision" ? decisionStep.plannedFiles : [],
            blockingReferences: workflowDecision.blockingReferences,
            decision: workflowDecision.allowed ? "allowed" : "blocked",
            recommendedTools: workflowDecision.recommendedTools,
            recoverable: workflowDecision.recoverable
          });
        }
      }
      // 旧调用方可能未创建工作流快照，继续使用原有通用门禁保持兼容。
      const patternFinderBlockReason = options.workflow ? null : getPatternFinderBlockReason(toolCall.name, agentContext, registry);
      const existenceCheckBlockReason = options.workflow ? null : getExistenceCheckBlockReason(toolCall.name, toolCall.arguments, agentContext, registry);
      // 精简评测或历史嵌入方未注册计划工具时维持兼容；标准 Runtime 始终注册该能力。
      const modificationPlanBlockReason = registry.get("planFileChanges")
        ? getModificationPlanBlockReason(toolCall.name, toolCall.arguments, agentContext)
        : null;

      if (workflowBlockReason) {
        metrics.recordToolFailure();
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: workflowBlockReason, workflow: options.workflow?.type });
        options.onAgentStep?.(createAgentStep({ type: "error", message: workflowBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, workflowBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      if (patternFinderBlockReason) {
        metrics.recordToolFailure();
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: patternFinderBlockReason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: patternFinderBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, patternFinderBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      if (existenceCheckBlockReason) {
        metrics.recordToolFailure();
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: existenceCheckBlockReason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: existenceCheckBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, existenceCheckBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      if (modificationPlanBlockReason) {
        metrics.recordToolFailure();
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
        logAi(runId, "runtime.toolBlocked", { toolName: toolCall.name, reason: modificationPlanBlockReason });
        options.onAgentStep?.(createAgentStep({ type: "error", message: modificationPlanBlockReason }));
        const blockedMessage = createBlockedToolMessage(toolCall, modificationPlanBlockReason);
        messages.push(blockedMessage);
        await persistAgentMessage(options.taskSessionId, blockedMessage);
        continue;
      }
      const approval = evaluateAgentToolApproval(toAgentToolCall(toolCall), definition);

      if (approval.status === "blocked") {
        metrics.recordToolFailure();
        metrics.recordToolResult({ signature, noProgress: true });
        consecutiveNoProgressSteps += 1;
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
        const evidence = await collectCompletionEvidence({
          taskSessionId: options.taskSessionId,
          workflowType,
          mutationExpected,
          generatedPatchIds,
          directAppliedFiles,
          agentContext,
          validationAvailable: Boolean(registry.get("runCommand")),
          failedToolCallCount: metrics.getCompletionEvidenceSnapshot().failedToolCallCount,
          lastMutationAt,
          lastValidationAt,
          pendingApprovalCount: 1
        });
        await persistRuntimeEvidence();
        await metrics.finish({
          status: "awaiting_approval",
          patchFileCount: countGeneratedPatchFiles(generatedPatchIds),
          validationCommandCount: agentContext.commandsRun?.filter((command) => command.validation === true).length ?? 0,
          validationStatus: evidence.validationStatus
        });

        return {
          status: "awaiting_approval",
          runId,
          content: `Waiting for approval to run ${pendingToolCall.toolName}.`,
          messages,
          agentContext,
          generatedPatchIds,
          runtimeEvidence: snapshotRuntimeEvidence(),
          pendingToolCall,
          contextBudgetSnapshot: latestContextBudgetSnapshot,
          contextSummary: latestContextSummary,
          completionEvidence: evidence,
          statusReason: "仍有工具调用等待用户审批。"
        };
      }

      try {
        const progressBefore = await createProgressSnapshot(agentContext, generatedPatchIds, options.taskSessionId, readScopes);
        const result = toModelToolMessage(await executeAgentToolCall(toAgentToolCall(toolCall), toolRuntime));
        const resultMetrics = analyzeToolResult(result.content);
        const safeEditorMetricDelta = getSafeEditorMetricDelta(result.content);
        if (safeEditorMetricDelta) metrics.recordSafeEditorMetrics(safeEditorMetricDelta);
        const appliedFilePaths = getConfirmedAppliedFilePaths(toolCall.name, result.content, toolCall.arguments);
        if (!resultMetrics.failed) {
          for (const filePath of appliedFilePaths) directAppliedFiles.add(filePath);
          if (appliedFilePaths.length) lastMutationAt = Date.now();
        }
        // 验证命令可能由工具更新 AgentContext；暂停到下一次审批前必须保留完成时间。
        lastValidationAt = Math.max(lastValidationAt ?? 0, getLatestValidationAt(agentContext) ?? 0) || undefined;
        const readScope = getSuccessfulReadScope(toolCall);
        if (!resultMetrics.cached && !resultMetrics.failed && readScope) readScopes.add(readScope);
        const newCreateIntents = promoteCreateIntentFacts(agentContext, {
          mode,
          workflowType,
          workspaceMutationAuthorized
        });
        const progressAfter = await createProgressSnapshot(agentContext, generatedPatchIds, options.taskSessionId, readScopes);
        // 结果是否为空只用于诊断；新增负面证据等状态变化仍然属于有效进展。
        const progressed = hasAgentProgress(progressBefore, progressAfter);
        if (resultMetrics.failed) metrics.recordToolFailure();
        metrics.recordToolResult({
          signature,
          cached: resultMetrics.cached,
          empty: resultMetrics.empty,
          noProgress: !progressed
        });
        consecutiveNoProgressSteps = progressed ? 0 : consecutiveNoProgressSteps + 1;
        messages.push(result);
        await persistAgentMessage(options.taskSessionId, result);
        const newEvidence = (agentContext.negativeEvidence || []).filter((item) => {
          if (!item.exhaustive) return false;
          const key = `${item.kind}:${item.scope}:${item.query}`;
          if (emittedNegativeEvidence.has(key)) return false;
          emittedNegativeEvidence.add(key);
          return true;
        });
        if (newEvidence.length) {
          const createdTargets = new Set(newCreateIntents.map((item) => `${item.scope}:${normalizeSearchTarget(item.target)}`));
          const facts = newEvidence.map((item) => {
            const isCreateIntent = createdTargets.has(`${item.scope}:${normalizeSearchTarget(item.query)}`);
            return isCreateIntent
              ? `目标“${item.query}”不存在，已确认需要在 ${item.scope} 创建；停止继续搜索同名目标`
              : `已完整检查 ${item.scope}，未发现“${item.query}”`;
          });
          options.onAgentStep?.(createAgentStep({
            type: "strategy",
            event: newCreateIntents.length ? "create_intent" : "negative_evidence",
            message: facts.join("；"),
            toolName: toolCall.name,
            currentStep: step + 1,
            maxSteps,
            facts
          }));
        }
      } catch (error) {
        metrics.recordToolFailure();
        throw error;
      }
    }

    if (repeatedToolNames.length) {
      const repeatedWarningMessage = createRepeatedToolWarningMessage([...new Set(repeatedToolNames)]);
      messages.push(repeatedWarningMessage);
      await persistAgentMessage(options.taskSessionId, repeatedWarningMessage);
      for (const toolName of [...new Set(repeatedToolNames)]) {
        options.onAgentStep?.(createAgentStep({
          type: "strategy",
          event: "repeated_tool_warning",
          message: "检测到相同参数的重复调用，请复用已有结果或切换到实现与验证。",
          toolName,
          currentStep: step + 1,
          maxSteps
        }));
      }
      logAi(runId, "runtime.repeatedToolWarning", { toolNames: repeatedToolNames });
    }

    if (consecutiveNoProgressSteps >= maxNoProgressSteps) {
      if (recoveryAttempts < allowedRecoveryAttempts) {
        recoveryAttempts += 1;
        consecutiveNoProgressSteps = 0;
        metrics.recordStrategyRecovery();
        const recoveryMessage = createNoProgressRecoveryMessage(
          maxNoProgressSteps,
          recoveryAttempts,
          agentContext,
          generatedPatchIds
        );
        messages.push(recoveryMessage);
        await persistAgentMessage(options.taskSessionId, recoveryMessage);
        options.onAgentStep?.(createAgentStep({
          type: "strategy",
          event: "no_progress_recovery",
          message: `连续 ${maxNoProgressSteps} 次工具调用无进展，正在切换策略（${recoveryAttempts}/${allowedRecoveryAttempts}）。`,
          currentStep: step + 1,
          maxSteps,
          facts: buildRecoveryFacts(agentContext, generatedPatchIds)
        }));
        logAi(runId, "runtime.noProgressRecovery", {
          step,
          threshold: maxNoProgressSteps,
          recoveryAttempt: recoveryAttempts
        });
      } else {
        const primaryRepeatedEntry = [...toolCallCounts.entries()]
          .filter(([, count]) => count > 1)
          .sort((left, right) => right[1] - left[1])[0];
        const content = createNoProgressStopContent(
          maxNoProgressSteps,
          recoveryAttempts,
          agentContext,
          generatedPatchIds,
          {
            currentStep: step + 1,
            maxSteps,
            toolCalls: [...toolCallCounts.values()].reduce((sum, count) => sum + count, 0),
            repeatedCalls: [...toolCallCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0),
            primaryRepeatedTool: primaryRepeatedEntry ? toolCallsBySignature.get(primaryRepeatedEntry[0]) : undefined
          }
        );
        options.onAgentStep?.(createAgentStep({
          type: "strategy",
          event: "no_progress_stop",
          message: content,
          currentStep: step + 1,
          maxSteps,
          facts: buildRecoveryFacts(agentContext, generatedPatchIds)
        }));
        options.onAgentStep?.(createAgentStep({ type: "error", message: content }));
        logAi(runId, "runtime.noProgressStopped", {
          step,
          threshold: maxNoProgressSteps,
          recoveryAttempts
        });
        await metrics.finish({
          status: "failed",
          stopReason: "no_progress",
          failureCategory: "tool_error",
          patchFileCount: countGeneratedPatchFiles(generatedPatchIds)
        });
        await persistRuntimeEvidence();
        return {
          status: "no_progress",
          runId,
          content,
          messages,
          agentContext,
          generatedPatchIds,
          runtimeEvidence: snapshotRuntimeEvidence(),
          pendingToolCall: null,
          contextBudgetSnapshot: latestContextBudgetSnapshot,
          contextSummary: latestContextSummary
        };
      }
    }
  }

  const content = createBudgetLimitContent(
    maxSteps,
    agentContext,
    generatedPatchIds,
    "模型在预算内未能返回最终结论。"
  );
  options.onAgentStep?.(createAgentStep({
    type: "strategy",
    event: "budget_stop",
    message: content,
    currentStep: maxSteps,
    maxSteps,
    facts: buildRecoveryFacts(agentContext, generatedPatchIds)
  }));
  options.onAgentStep?.(createAgentStep({ type: "error", message: content }));
  logAi(runId, "runtime.stepLimitReached", { mode, maxSteps });
  await metrics.finish({ status: "step_limit_reached", stopReason: "step_limit", failureCategory: "step_limit", patchFileCount: countGeneratedPatchFiles(generatedPatchIds) });
  await persistRuntimeEvidence();

  return {
    status: "step_limit_reached",
    runId,
    content,
    messages,
    agentContext,
    generatedPatchIds,
    runtimeEvidence: snapshotRuntimeEvidence(),
    pendingToolCall: null,
    contextBudgetSnapshot: latestContextBudgetSnapshot,
    contextSummary: latestContextSummary
  };
  } catch (error) {
    const cancelled = error instanceof Error && error.name === "AbortError";
    await metrics.finish({
      status: cancelled ? "cancelled" : "failed",
      stopReason: cancelled ? "cancelled" : "provider_error",
      failureCategory: classifyRunFailure(error),
      patchFileCount: countGeneratedPatchFiles(generatedPatchIds)
    });
    throw error;
  }
}
