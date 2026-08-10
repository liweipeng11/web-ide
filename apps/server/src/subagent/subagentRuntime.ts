import { runAgentRuntime, type AgentRuntimeOptions, type AgentRuntimeResult } from "../agentRuntime.js";
import {
  createAnalysisSubagentRegistry,
  getAnalysisSubagentAllowedTools,
  createImplementationSubagentRegistry,
  getImplementationSubagentAllowedTools,
  createPlanningSubagentRegistry,
  getPlanningSubagentAllowedTools
} from "./subagentRegistry.js";
import { buildAnalysisSubagentSystemPrompt, buildImplementationSubagentSystemPrompt, buildPlanningSubagentSystemPrompt } from "../prompts.js";
import { createAiRunId, logAi } from "../aiHttp.js";
import {
  createSubagentCreatedStep,
  createSubagentStartedStep,
  createSubagentSucceededStep,
  createSubagentFailedStep
} from "../routeAgentSteps.js";
import type { AgentStep } from "../types.js";
import type {
  AgentSubagentDelegationInput,
  AgentSubagentDelegationResult,
  SubagentArtifacts,
  SubagentArtifactsKind,
  SubagentBudgetPolicy,
  SubagentDelegationScope,
  SubagentFailure,
  SubagentIdentity,
  SubagentKind,
  SubagentSnapshot,
  SubagentStatus
} from "../agentToolTypes.js";
import type { TaskProgressCallback } from "../agentToolTypes.js";
import type { AgentToolRegistry } from "../agentToolRegistry.js";

// 默认子代理预算：步数少、读取文件数少，确保子代理只做局部工作。
const DEFAULT_ANALYSIS_SUBAGENT_MAX_STEPS = 12;
const DEFAULT_ANALYSIS_SUBAGENT_MAX_FILES_READ = 6;
const DEFAULT_IMPLEMENTATION_SUBAGENT_MAX_STEPS = 16;
const DEFAULT_IMPLEMENTATION_SUBAGENT_MAX_FILES_READ = 8;

/**
 * 子代理运行时选项，由父代理委派工具构造。
 * 与父代理共享 taskSessionId，但 runId、agentContext、registry 全部隔离。
 */
export type SubagentRuntimeOptions = {
  parentRunId: string;
  taskSessionId: string | null;
  delegationId: string;
  subagentId: string;
  input: AgentSubagentDelegationInput;
  onAgentStep?: (step: AgentStep) => void;
  onTaskProgress?: TaskProgressCallback;
  modelId?: string;
  providerId?: string;
  signal?: AbortSignal;
  requestCompletion?: AgentRuntimeOptions["requestCompletion"];
  completeModel?: AgentRuntimeOptions["completeModel"];
  metricsRecorder?: AgentRuntimeOptions["metricsRecorder"];
};

/** 子代理运行配置，由外层按 kind 注入。 */
type SubagentRunConfig = {
  kind: SubagentKind;
  registry: AgentToolRegistry;
  defaultAllowedTools: string[];
  defaultMaxSteps: number;
  defaultMaxReadFiles: number;
  mode: "plan" | "act";
  runIdPrefix: string;
  systemPromptBuilder: (goal: string, scope: SubagentDelegationScope, budget: SubagentBudgetPolicy, hints: string[], allowedTools: string[]) => string;
  failureSuggestedAction: string;
};

/**
 * 阶段 3 通用化：子代理运行时核心逻辑，按 kind 注入 registry、prompt、预算和模式。
 */
async function runSubagentCore(options: SubagentRuntimeOptions, config: SubagentRunConfig): Promise<AgentSubagentDelegationResult> {
  const { parentRunId, taskSessionId, delegationId, subagentId, input } = options;

  // 构造子代理身份
  const identity: SubagentIdentity = {
    subagentId,
    parentRunId,
    delegationId,
    kind: config.kind,
    title: input.title
  };

  const allowedTools = config.defaultAllowedTools;
  const scope: SubagentDelegationScope = {
    allowedFilePaths: input.scope?.allowedFilePaths ?? [],
    allowedFileGlobs: input.scope?.allowedFileGlobs ?? [],
    allowedToolNames: input.scope?.allowedToolNames ?? allowedTools,
    canMutateWorkspace: config.kind === "implementation",
    canRequestApproval: false,
    canCompleteTask: true
  };
  const budget: SubagentBudgetPolicy = {
    maxSteps: input.budget?.maxSteps ?? config.defaultMaxSteps,
    maxReadFiles: input.budget?.maxReadFiles ?? config.defaultMaxReadFiles,
    maxOutputTokens: input.budget?.maxOutputTokens,
    maxPromptTokens: input.budget?.maxPromptTokens,
    timeoutMs: input.budget?.timeoutMs
  };

  // 发送 created + started 步骤到父代理步骤流
  options.onAgentStep?.(createSubagentCreatedStep({
    delegationId,
    subagentId,
    title: input.title,
    kind: config.kind,
    goal: input.goal,
    scope,
    budget
  }));

  const runId = createAiRunId(config.runIdPrefix);
  options.onAgentStep?.(createSubagentStartedStep({
    delegationId,
    subagentId,
    parentRunId,
    runId,
    mode: config.mode
  }));

  logAi(runId, `subagent.${config.kind}.start`, { delegationId, subagentId, parentRunId, goal: input.goal });

  // 构造子代理 system prompt
  const systemPrompt = config.systemPromptBuilder(
    input.goal,
    scope,
    budget,
    input.hints ?? [],
    scope.allowedToolNames ?? allowedTools
  );

  // 构造子代理 agentContext（独立，不继承父代理），阶段 3 注入子代理身份用于 patch 来源标记
  const subagentAgentContext = {
    userGoal: input.goal,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: [],
    isSubagent: true,
    parentRunId,
    subagentDelegationId: delegationId,
    subagentId
  };

  const startedAt = Date.now();

  try {
    const runtimeResult = await runAgentRuntime({
      userRequest: input.goal,
      runId,
      taskSessionId,
      mode: config.mode,
      registry: config.registry,
      maxSteps: budget.maxSteps,
      agentContext: subagentAgentContext,
      onAgentStep: options.onAgentStep,
      onTaskProgress: options.onTaskProgress,
      modelId: options.modelId,
      providerId: options.providerId,
      signal: options.signal,
      requestCompletion: options.requestCompletion,
      completeModel: options.completeModel,
      metricsRecorder: options.metricsRecorder,
      projectMemoryPrompt: null,
      // 阶段 4：标记为子代理运行，激活审批/完成门禁的子代理模式。
      isSubagent: true
    });

    const finishedAt = Date.now();

    // 阶段 5：子代理步数耗尽时，检查是否产出了有效内容。有内容则视为成功（子代理尽力了），
    // 无内容则转为可诊断失败，父代理据此决定重试/缩小范围/降级。
    if (runtimeResult.status === "step_limit_reached") {
      const partialContent = runtimeResult.content?.trim();
      if (partialContent && partialContent.length > 20) {
        // 子代理步数耗尽但有有效内容，视为部分成功
        const artifactsKind: SubagentArtifactsKind = config.kind === "implementation" ? "proposed_patch" : config.kind === "planning" ? "modification_plan" : "analysis";
        const artifacts = extractArtifactsFromRuntimeResult(runtimeResult, artifactsKind);
        artifacts.risks = [{ severity: "medium", description: "子代理步数耗尽但产出了部分有效内容，父代理需评估是否需补充分析或直接使用。", filePaths: artifacts.relevantFiles }];

        options.onAgentStep?.(createSubagentSucceededStep({
          delegationId,
          subagentId,
          artifactsKind,
          summary: `[步数耗尽，部分结果] ${artifacts.summary}`,
          relevantFiles: artifacts.relevantFiles,
          producedPatchCount: runtimeResult.generatedPatchIds.length
        }));

        logAi(runId, `subagent.${config.kind}.stepExhausted`, { delegationId, subagentId, durationMs: finishedAt - startedAt, partialContentLength: partialContent.length });

        return {
          ...identity,
          status: "succeeded" as SubagentStatus,
          artifacts,
          runtime: {
            runId,
            mode: config.mode,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            stepsUsed: budget.maxSteps,
            promptTokens: undefined,
            completionTokens: undefined
          }
        };
      }

      // 无有效内容：转为可诊断失败
      const failure: SubagentFailure = {
        code: "SUBAGENT_STEP_EXHAUSTED",
        reason: `子代理在 ${budget.maxSteps} 步预算内未产出有效内容。已读取 ${subagentAgentContext.filesRead.length} 个文件，执行 ${subagentAgentContext.searchQueries.length} 次搜索。`,
        recoverable: true,
        suggestedAction: `父代理可：1) 缩小 allowedFilePaths 范围后重试；2) 增加 maxSteps 预算；3) 降级为父代理直接执行${config.kind === "analysis" ? "分析" : "实施"}。`
      };

      options.onAgentStep?.(createSubagentFailedStep({
        delegationId,
        subagentId,
        failure
      }));

      logAi(runId, `subagent.${config.kind}.stepExhaustedEmpty`, { delegationId, subagentId, durationMs: finishedAt - startedAt, filesRead: subagentAgentContext.filesRead.length });

      return {
        ...identity,
        status: "failed" as SubagentStatus,
        failure,
        runtime: {
          runId,
          mode: config.mode,
          startedAt,
          finishedAt,
          durationMs: finishedAt - startedAt
        }
      };
    }

    const artifactsKind: SubagentArtifactsKind = config.kind === "implementation" ? "proposed_patch" : config.kind === "planning" ? "modification_plan" : "analysis";
    const artifacts = extractArtifactsFromRuntimeResult(runtimeResult, artifactsKind);

    options.onAgentStep?.(createSubagentSucceededStep({
      delegationId,
      subagentId,
      artifactsKind,
      summary: artifacts.summary,
      relevantFiles: artifacts.relevantFiles,
      producedPatchCount: runtimeResult.generatedPatchIds.length
    }));

    logAi(runId, `subagent.${config.kind}.succeeded`, {
      delegationId,
      subagentId,
      durationMs: finishedAt - startedAt,
      patchCount: runtimeResult.generatedPatchIds.length
    });

    return {
      ...identity,
      status: "succeeded" as SubagentStatus,
      artifacts,
      runtime: {
        runId,
        mode: config.mode,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
        stepsUsed: runtimeResult.agentContext.filesRead.length,
        promptTokens: undefined,
        completionTokens: undefined
      }
    };
  } catch (error) {
    const finishedAt = Date.now();
    const failure: SubagentFailure = {
      code: "SUBAGENT_RUNTIME_ERROR",
      reason: error instanceof Error ? error.message : "unknown error",
      recoverable: true,
      suggestedAction: config.failureSuggestedAction
    };

    options.onAgentStep?.(createSubagentFailedStep({
      delegationId,
      subagentId,
      failure
    }));

    logAi(runId, `subagent.${config.kind}.failed`, { delegationId, subagentId, error: failure.reason, durationMs: finishedAt - startedAt });

    return {
      ...identity,
      status: "failed" as SubagentStatus,
      failure,
      runtime: {
        runId,
        mode: config.mode,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt
      }
    };
  }
}

// 阶段 2/3 分析型 system prompt builder
function analysisSystemPromptBuilder(goal: string, scope: SubagentDelegationScope, budget: SubagentBudgetPolicy, hints: string[], allowedTools: string[]) {
  return buildAnalysisSubagentSystemPrompt({
    goal,
    allowedFilePaths: scope.allowedFilePaths ?? [],
    allowedFileGlobs: scope.allowedFileGlobs ?? [],
    allowedTools: scope.allowedToolNames ?? allowedTools,
    maxSteps: budget.maxSteps ?? DEFAULT_ANALYSIS_SUBAGENT_MAX_STEPS,
    maxFilesRead: budget.maxReadFiles ?? DEFAULT_ANALYSIS_SUBAGENT_MAX_FILES_READ,
    hints
  });
}

// 阶段 3 实施型 system prompt builder
function implementationSystemPromptBuilder(goal: string, scope: SubagentDelegationScope, budget: SubagentBudgetPolicy, hints: string[], allowedTools: string[]) {
  return buildImplementationSubagentSystemPrompt({
    goal,
    allowedFilePaths: scope.allowedFilePaths ?? [],
    allowedFileGlobs: scope.allowedFileGlobs ?? [],
    allowedTools: scope.allowedToolNames ?? allowedTools,
    maxSteps: budget.maxSteps ?? DEFAULT_IMPLEMENTATION_SUBAGENT_MAX_STEPS,
    maxReadFiles: budget.maxReadFiles ?? DEFAULT_IMPLEMENTATION_SUBAGENT_MAX_FILES_READ,
    hints
  });
}

/**
 * 运行 analysis 子代理，复用 runAgentRuntime 但以受限 registry 和子代理 system prompt 启动。
 * 子代理拿独立 runId、独立 agentContext、独立预算；运行结束后把结构化产物回传给父代理。
 */
export async function runAnalysisSubagent(options: SubagentRuntimeOptions): Promise<AgentSubagentDelegationResult> {
  return runSubagentCore(options, {
    kind: "analysis",
    registry: createAnalysisSubagentRegistry(),
    defaultAllowedTools: getAnalysisSubagentAllowedTools(),
    defaultMaxSteps: DEFAULT_ANALYSIS_SUBAGENT_MAX_STEPS,
    defaultMaxReadFiles: DEFAULT_ANALYSIS_SUBAGENT_MAX_FILES_READ,
    mode: "plan",
    runIdPrefix: "analysis-subagent",
    systemPromptBuilder: analysisSystemPromptBuilder,
    failureSuggestedAction: "父代理可缩小范围后重试，或降级为父代理直接执行分析。"
  });
}

// 阶段 3：运行 implementation 子代理，以 act 模式启动但受限 registry（只读 + proposePatch）。
export async function runImplementationSubagent(options: SubagentRuntimeOptions): Promise<AgentSubagentDelegationResult> {
  return runSubagentCore(options, {
    kind: "implementation",
    registry: createImplementationSubagentRegistry(),
    defaultAllowedTools: getImplementationSubagentAllowedTools(),
    defaultMaxSteps: DEFAULT_IMPLEMENTATION_SUBAGENT_MAX_STEPS,
    defaultMaxReadFiles: DEFAULT_IMPLEMENTATION_SUBAGENT_MAX_FILES_READ,
    mode: "act",
    runIdPrefix: "implementation-subagent",
    systemPromptBuilder: implementationSystemPromptBuilder,
    failureSuggestedAction: "父代理可缩小文件范围后重试，或由父代理直接执行实施并生成 patch。"
  });
}

// 新增：planning 子代理 system prompt builder。
function planningSystemPromptBuilder(goal: string, scope: SubagentDelegationScope, budget: SubagentBudgetPolicy, hints: string[], allowedTools: string[]) {
  return buildPlanningSubagentSystemPrompt({
    goal,
    allowedFilePaths: scope.allowedFilePaths ?? [],
    allowedFileGlobs: scope.allowedFileGlobs ?? [],
    allowedTools: scope.allowedToolNames ?? allowedTools,
    maxSteps: budget.maxSteps ?? DEFAULT_ANALYSIS_SUBAGENT_MAX_STEPS,
    maxFilesRead: budget.maxReadFiles ?? DEFAULT_ANALYSIS_SUBAGENT_MAX_FILES_READ,
    hints
  });
}

const DEFAULT_PLANNING_SUBAGENT_MAX_STEPS = 12;
const DEFAULT_PLANNING_SUBAGENT_MAX_FILES_READ = 8;

// 新增：运行 planning 子代理，以 plan 模式启动，使用只读工具 + planFileChanges。
// 子代理调研代码库并产出结构化修改计划，父代理按计划执行编辑。
export async function runPlanningSubagent(options: SubagentRuntimeOptions): Promise<AgentSubagentDelegationResult> {
  return runSubagentCore(options, {
    kind: "planning",
    registry: createPlanningSubagentRegistry(),
    defaultAllowedTools: getPlanningSubagentAllowedTools(),
    defaultMaxSteps: DEFAULT_PLANNING_SUBAGENT_MAX_STEPS,
    defaultMaxReadFiles: DEFAULT_PLANNING_SUBAGENT_MAX_FILES_READ,
    mode: "plan",
    runIdPrefix: "planning-subagent",
    systemPromptBuilder: planningSystemPromptBuilder,
    failureSuggestedAction: "父代理可缩小范围后重试，或降级为父代理直接执行规划和编辑。"
  });
}

/**
 * 从 runAgentRuntime 结果中提取子代理产物。
 */
function extractArtifactsFromRuntimeResult(result: AgentRuntimeResult, kind: SubagentArtifactsKind): SubagentArtifacts {
  const relevantFiles = [...new Set([
    ...result.agentContext.relevantFiles,
    ...result.agentContext.searchResultFiles,
    ...result.agentContext.filesRead
  ])];

  const patch = kind === "proposed_patch" && result.generatedPatchIds.length > 0
    ? { patchId: result.generatedPatchIds[0], patchIds: result.generatedPatchIds }
    : undefined;

  // 新增：planning 子代理的 modificationPlan 产物。
  const modificationPlan = kind === "modification_plan" && result.agentContext.modificationPlan
    ? {
        planId: result.agentContext.modificationPlan.id,
        taskDescription: result.agentContext.modificationPlan.taskDescription,
        files: result.agentContext.modificationPlan.files.map((f) => ({
          filePath: f.filePath,
          changeKind: f.changeKind,
          reason: f.reason,
          ...(f.symbolName ? { symbolName: f.symbolName } : {}),
          ...(f.responsibility ? { responsibility: f.responsibility } : {})
        }))
      }
    : undefined;

  return {
    kind,
    summary: result.content || "子代理未输出内容",
    structuredEvidence: {
      filesRead: result.agentContext.filesRead,
      searchQueries: result.agentContext.searchQueries,
      relevantFiles: result.agentContext.searchResultFiles,
      impactAnalyses: result.agentContext.impactAnalyses ?? [],
      negativeEvidence: result.agentContext.negativeEvidence ?? []
    },
    relevantFiles,
    patch,
    modificationPlan,
    risks: [],
    nextActions: []
  };
}

/**
 * 把子代理运行结果转换为持久化快照，供 taskSessionStore 写入。
 */
export function subagentResultToSnapshot(result: AgentSubagentDelegationResult, input: AgentSubagentDelegationInput, defaultAllowedTools: string[], defaultMaxSteps: number, defaultMaxReadFiles: number): SubagentSnapshot {
  const now = Date.now();
  const kind = result.kind ?? input.kind;
  return {
    subagentId: result.subagentId,
    parentRunId: result.parentRunId,
    delegationId: result.delegationId,
    kind,
    title: input.title,
    goal: input.goal,
    scope: input.scope ?? {
      allowedFilePaths: [],
      allowedFileGlobs: [],
      allowedToolNames: defaultAllowedTools,
      canMutateWorkspace: kind === "implementation",
      canRequestApproval: false,
      canCompleteTask: true
    },
    budget: input.budget ?? {
      maxSteps: defaultMaxSteps,
      maxReadFiles: defaultMaxReadFiles
    },
    status: result.status,
    artifacts: result.artifacts,
    failure: result.failure,
    runtime: result.runtime,
    createdAt: now,
    updatedAt: now
  };
}
