import { runAnalysisSubagent, runImplementationSubagent, runPlanningSubagent, subagentResultToSnapshot } from "./subagentRuntime.js";
import {
  getAnalysisSubagentAllowedTools,
  getImplementationSubagentAllowedTools,
  getPlanningSubagentAllowedTools
} from "./subagentRegistry.js";
import { runParallelAnalysisSubagents, type ParallelSubagentTask } from "./subagentParallelScheduler.js";
import { upsertSubagentSnapshot, setSubagentSummary } from "../taskSessionStore.js";
import type { AgentToolDefinition } from "../agentToolTypes.js";
import { logAi } from "../aiHttp.js";

// 阶段 2/3：delegateSubagent 委派工具定义。
// 父代理调用此工具触发子代理运行；子代理运行结束后结果回传给父代理。
// 阶段 2 支持 kind=analysis，阶段 3 扩展 kind=implementation。

/** 委派工具参数校验 */
function parseDelegateSubagentArgs(args: Record<string, unknown>) {
  if (typeof args.title !== "string" || !args.title.trim()) {
    throw new Error("title is required and must be a non-empty string");
  }
  if (typeof args.goal !== "string" || !args.goal.trim()) {
    throw new Error("goal is required and must be a non-empty string");
  }
  const kind = args.kind;
  if (kind !== "analysis" && kind !== "implementation" && kind !== "planning") {
    throw new Error(`Unsupported subagent kind "${kind}"; only "analysis", "implementation", and "planning" are allowed`);
  }

  const expectedKind = args.expectedArtifactsKind;
  if (kind === "analysis" && expectedKind !== "analysis") {
    throw new Error(`expectedArtifactsKind "${expectedKind}" must be "analysis" when kind is "analysis"`);
  }
  if (kind === "implementation" && expectedKind !== "proposed_patch") {
    throw new Error(`expectedArtifactsKind "${expectedKind}" must be "proposed_patch" when kind is "implementation"`);
  }
  if (kind === "planning" && expectedKind !== "modification_plan") {
    throw new Error(`expectedArtifactsKind "${expectedKind}" must be "modification_plan" when kind is "planning"`);
  }

  const allowedFilePaths = Array.isArray(args.allowedFilePaths)
    ? args.allowedFilePaths.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
  const allowedFileGlobs = Array.isArray(args.allowedFileGlobs)
    ? args.allowedFileGlobs.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
  const hints = Array.isArray(args.hints)
    ? args.hints.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];

  const maxSteps = typeof args.maxSteps === "number" && Number.isInteger(args.maxSteps) && args.maxSteps > 0 ? args.maxSteps : undefined;
  const maxFilesRead = typeof args.maxFilesRead === "number" && Number.isInteger(args.maxFilesRead) && args.maxFilesRead > 0 ? args.maxFilesRead : undefined;

  return {
    title: args.title.trim(),
    kind: kind as "analysis" | "implementation",
    goal: args.goal.trim(),
    expectedArtifactsKind: expectedKind as "analysis" | "proposed_patch",
    allowedFilePaths,
    allowedFileGlobs,
    hints,
    maxSteps,
    maxFilesRead
  };
}

// 按 kind 获取默认工具列表和预算
function getSubagentConfig(kind: "analysis" | "implementation" | "planning") {
  if (kind === "analysis") {
    return {
      allowedTools: getAnalysisSubagentAllowedTools(),
      defaultMaxSteps: 12,
      defaultMaxReadFiles: 6,
      canMutateWorkspace: false
    };
  }
  if (kind === "implementation") {
    return {
      allowedTools: getImplementationSubagentAllowedTools(),
      defaultMaxSteps: 16,
      defaultMaxReadFiles: 8,
      canMutateWorkspace: true
    };
  }
  return {
    allowedTools: getPlanningSubagentAllowedTools(),
    defaultMaxSteps: 12,
    defaultMaxReadFiles: 8,
    canMutateWorkspace: false
  };
}

export const subagentDelegationToolDefinitions: AgentToolDefinition[] = [
  {
    name: "delegateSubagent",
    description:
      "Delegate a well-scoped subgoal to a subagent. Supported kinds: 'analysis' (read-only investigation, returns analysis artifacts) and 'implementation' (can read + proposePatch, returns reviewable patches). The subagent runs with independent runId, context, and bounded budget. Patches produced by implementation subagents are reviewable-only and recovered by the parent for final merge.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          description: "Concise title of the delegated subgoal, e.g. 'Analyze auth middleware impact' or 'Implement user profile API endpoint'."
        },
        kind: {
          type: "string",
          enum: ["analysis", "implementation", "planning"],
          description: "Subagent kind: 'analysis' for read-only investigation, 'implementation' for read + proposePatch, 'planning' for investigation + modification plan declaration."
        },
        goal: {
          type: "string",
          minLength: 1,
          description: "The precise goal the subagent must accomplish within its scope."
        },
        expectedArtifactsKind: {
          type: "string",
          enum: ["analysis", "proposed_patch", "modification_plan"],
          description: "Expected artifact kind. 'analysis' for investigation results, 'proposed_patch' for reviewable patches, 'modification_plan' for structured modification plans."
        },
        allowedFilePaths: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Optional workspace-relative files the subagent is allowed to read/write. Empty means inherit workspace root."
        },
        allowedFileGlobs: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Optional glob patterns to broaden the allowed file scope."
        },
        maxSteps: {
          type: "integer",
          minimum: 1,
          description: "Optional step budget override. Default is 12 for analysis, 16 for implementation."
        },
        maxFilesRead: {
          type: "integer",
          minimum: 1,
          description: "Optional file read budget override. Default is 6 for analysis, 8 for implementation."
        },
        hints: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "Optional hints to guide the subagent's approach."
        }
      },
      required: ["title", "kind", "goal", "expectedArtifactsKind"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const parsed = parseDelegateSubagentArgs(args);
      const config = getSubagentConfig(parsed.kind);

      // 生成 delegationId 和 subagentId
      const delegationId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const subagentId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      logAi(runtime.runId, "subagent.delegate", { delegationId, subagentId, kind: parsed.kind, title: parsed.title, goal: parsed.goal });

      const input = {
        title: parsed.title,
        kind: parsed.kind,
        goal: parsed.goal,
        expectedArtifactsKind: parsed.expectedArtifactsKind,
        scope: {
          allowedFilePaths: parsed.allowedFilePaths,
          allowedFileGlobs: parsed.allowedFileGlobs,
          allowedToolNames: config.allowedTools,
          canMutateWorkspace: config.canMutateWorkspace,
          canRequestApproval: false,
          canCompleteTask: true
        },
        budget: {
          maxSteps: parsed.maxSteps ?? config.defaultMaxSteps,
          maxReadFiles: parsed.maxFilesRead ?? config.defaultMaxReadFiles
        },
        hints: parsed.hints
      };

      const runtimeOptions = {
        parentRunId: runtime.runId,
        taskSessionId: runtime.taskSessionId ?? null,
        delegationId,
        subagentId,
        input,
        onAgentStep: runtime.onAgentStep,
        onTaskProgress: undefined,
        modelId: undefined,
        providerId: undefined,
        signal: undefined,
        requestCompletion: undefined,
        completeModel: undefined,
        metricsRecorder: undefined
      };

      // 按 kind 分发到对应的子代理运行时
      const result = parsed.kind === "analysis"
        ? await runAnalysisSubagent(runtimeOptions)
        : parsed.kind === "implementation"
        ? await runImplementationSubagent(runtimeOptions)
        : await runPlanningSubagent(runtimeOptions);

      // 持久化子代理快照到任务会话
      if (runtime.taskSessionId) {
        const snapshot = subagentResultToSnapshot(
          result,
          { ...input, budget: { maxSteps: input.budget.maxSteps ?? config.defaultMaxSteps, maxReadFiles: input.budget.maxReadFiles ?? config.defaultMaxReadFiles } },
          config.allowedTools,
          config.defaultMaxSteps,
          config.defaultMaxReadFiles
        );
        try {
          await upsertSubagentSnapshot(runtime.taskSessionId, snapshot);
          await setSubagentSummary(runtime.taskSessionId);
        } catch (error) {
          console.warn("[subagent] failed to persist snapshot", error instanceof Error ? error.message : "unknown error");
        }
      }

      // 把结构化结果回传给父代理模型
      return {
        delegationId,
        subagentId,
        status: result.status,
        kind: result.kind,
        artifacts: result.artifacts,
        failure: result.failure,
        runtime: result.runtime
      };
    },
    summarize(result) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const artifacts = value.artifacts && typeof value.artifacts === "object" ? (value.artifacts as Record<string, unknown>) : {};
      const patch = artifacts.patch && typeof artifacts.patch === "object" ? (artifacts.patch as Record<string, unknown>) : {};
      return {
        delegationId: value.delegationId,
        subagentId: value.subagentId,
        status: value.status,
        kind: value.kind,
        artifactsKind: artifacts.kind,
        summary: artifacts.summary,
        relevantFileCount: Array.isArray(artifacts.relevantFiles) ? artifacts.relevantFiles.length : 0,
        patchCount: Array.isArray(patch.patchIds) ? (patch.patchIds as string[]).length : (patch.patchId ? 1 : 0),
        hasFailure: value.failure != null
      };
    }
  }
];

export const delegateSubagentToolDefinition = subagentDelegationToolDefinitions[0];

// 阶段 6：并行委派工具，批量并行执行多个 analysis 子代理。
// 只允许 analysis 类型（implementation 有 patch 冲突风险）。
// 父代理可同时委派多个独立分析任务，调度器控制并发数、检测文件冲突、传播取消信号。
export const parallelDelegationToolDefinitions: AgentToolDefinition[] = [
  {
    name: "delegateParallelSubagents",
    description:
      "Delegate multiple independent analysis subgoals to parallel read-only subagents. All subagents run concurrently (max concurrency 4). Each returns structured analysis artifacts. Use this when you have multiple unrelated analysis tasks (e.g. analyzing auth module, database schema, and API layer simultaneously). Only analysis kind is supported for parallel execution; do not use for implementation tasks.",
    cacheable: false,
    parameters: {
      type: "object",
      properties: {
        delegations: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            properties: {
              title: {
                type: "string",
                minLength: 1,
                description: "Title for this sub-delegation, e.g. 'Analyze auth module'."
              },
              goal: {
                type: "string",
                minLength: 1,
                description: "The precise analysis goal for this sub-delegation."
              },
              allowedFilePaths: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "Optional files this subagent is allowed to read."
              },
              allowedFileGlobs: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "Optional glob patterns for this subagent."
              },
              maxSteps: {
                type: "integer",
                minimum: 1,
                description: "Optional step budget override for this subagent."
              },
              maxFilesRead: {
                type: "integer",
                minimum: 1,
                description: "Optional file read budget override for this subagent."
              },
              hints: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "Optional hints for this subagent."
              }
            },
            required: ["title", "goal"],
            additionalProperties: false
          },
          description: "Array of sub-delegation tasks to run in parallel. Each task describes an independent analysis subgoal."
        },
        maxConcurrency: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "Optional max concurrent subagents. Default is 4."
        }
      },
      required: ["delegations"],
      additionalProperties: false
    },
    async execute(args, runtime) {
      const delegations = args.delegations;
      if (!Array.isArray(delegations) || delegations.length < 2) {
        throw new Error("delegations must be an array with at least 2 items");
      }

      const tasks: ParallelSubagentTask[] = delegations.map((item: Record<string, unknown>) => {
        if (typeof item.title !== "string" || !item.title.trim()) {
          throw new Error("Each delegation must have a non-empty title");
        }
        if (typeof item.goal !== "string" || !item.goal.trim()) {
          throw new Error("Each delegation must have a non-empty goal");
        }
        return {
          title: item.title.trim(),
          goal: item.goal.trim(),
          allowedFilePaths: Array.isArray(item.allowedFilePaths)
            ? item.allowedFilePaths.filter((f): f is string => typeof f === "string")
            : undefined,
          allowedFileGlobs: Array.isArray(item.allowedFileGlobs)
            ? item.allowedFileGlobs.filter((g): g is string => typeof g === "string")
            : undefined,
          maxSteps: typeof item.maxSteps === "number" && item.maxSteps > 0 ? item.maxSteps : undefined,
          maxFilesRead: typeof item.maxFilesRead === "number" && item.maxFilesRead > 0 ? item.maxFilesRead : undefined,
          hints: Array.isArray(item.hints)
            ? item.hints.filter((h): h is string => typeof h === "string")
            : undefined
        };
      });

      const maxConcurrency = typeof args.maxConcurrency === "number" && args.maxConcurrency > 0
        ? args.maxConcurrency
        : undefined;

      logAi(runtime.runId, "subagent.parallel.delegate", { taskCount: tasks.length, maxConcurrency });

      const schedulerResult = await runParallelAnalysisSubagents(tasks, {
        parentRunId: runtime.runId,
        taskSessionId: runtime.taskSessionId ?? null,
        onAgentStep: runtime.onAgentStep,
        maxConcurrency
      });

      // 持久化所有子代理快照
      if (runtime.taskSessionId) {
        const config = getSubagentConfig("analysis");
        for (const result of schedulerResult.results) {
          if (result.status === "succeeded" || result.status === "failed") {
            const snapshot = subagentResultToSnapshot(
              result,
              {
                title: result.title ?? "",
                kind: "analysis",
                goal: "",
                expectedArtifactsKind: "analysis",
                scope: {
                  allowedFilePaths: [],
                  allowedFileGlobs: [],
                  allowedToolNames: config.allowedTools,
                  canMutateWorkspace: false,
                  canRequestApproval: false,
                  canCompleteTask: true
                },
                budget: { maxSteps: config.defaultMaxSteps, maxReadFiles: config.defaultMaxReadFiles },
                hints: []
              },
              config.allowedTools,
              config.defaultMaxSteps,
              config.defaultMaxReadFiles
            );
            try {
              await upsertSubagentSnapshot(runtime.taskSessionId, snapshot);
            } catch {
              console.warn("[subagent] failed to persist parallel snapshot");
            }
          }
        }
        try {
          await setSubagentSummary(runtime.taskSessionId);
        } catch {
          console.warn("[subagent] failed to update parallel summary");
        }
      }

      return {
        totalTasks: schedulerResult.summary.totalTasks,
        succeeded: schedulerResult.summary.succeeded,
        failed: schedulerResult.summary.failed,
        cancelled: schedulerResult.summary.cancelled,
        concurrentPeak: schedulerResult.summary.concurrentPeak,
        totalDurationMs: schedulerResult.summary.totalDurationMs,
        conflicts: schedulerResult.conflicts.map((c) => ({
          taskA: c.taskA,
          taskB: c.taskB,
          conflictingFiles: c.conflictingFiles,
          severity: c.severity,
          reason: c.reason
        })),
        results: schedulerResult.results.map((r) => ({
          delegationId: r.delegationId,
          subagentId: r.subagentId,
          title: r.title,
          status: r.status,
          artifactsKind: r.artifacts?.kind,
          summary: r.artifacts?.summary ?? r.failure?.reason ?? "",
          relevantFileCount: r.artifacts?.relevantFiles?.length ?? 0,
          hasFailure: r.failure != null
        }))
      };
    },
    summarize(result) {
      const value = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      const results = Array.isArray(value.results) ? value.results : [];
      return {
        totalTasks: value.totalTasks,
        succeeded: value.succeeded,
        failed: value.failed,
        cancelled: value.cancelled,
        concurrentPeak: value.concurrentPeak,
        totalDurationMs: value.totalDurationMs,
        conflictCount: Array.isArray(value.conflicts) ? (value.conflicts as unknown[]).length : 0,
        topResults: (results as Array<Record<string, unknown>>).slice(0, 5).map((r) => ({
          title: r.title,
          status: r.status,
          summary: typeof r.summary === "string" ? r.summary.slice(0, 100) : ""
        }))
      };
    }
  }
];

export const delegateParallelSubagentsToolDefinition = parallelDelegationToolDefinitions[0];
