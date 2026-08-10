import { runAnalysisSubagent, type SubagentRuntimeOptions } from "./subagentRuntime.js";
import type { AgentSubagentDelegationInput, AgentSubagentDelegationResult } from "../agentToolTypes.js";
import type { AgentStep } from "../types.js";
import { logAi } from "../aiHttp.js";

// 阶段 6：并行子代理调度器。
// 管理最大并发数、同文件冲突预检、取消传播和结果聚合。
// 第一步只并行只读 analysis 子代理，第二步再扩展 implementation。

const DEFAULT_MAX_CONCURRENCY = 4;

export type ParallelSubagentTask = {
  title: string;
  goal: string;
  allowedFilePaths?: string[];
  allowedFileGlobs?: string[];
  maxSteps?: number;
  maxFilesRead?: number;
  hints?: string[];
};

export type ParallelSchedulerOptions = {
  parentRunId: string;
  taskSessionId: string | null;
  onAgentStep?: (step: AgentStep) => void;
  /** 最大并发数，默认 4。 */
  maxConcurrency?: number;
  /** 父代理 AbortSignal，父代理取消时传播到所有子代理。 */
  parentSignal?: AbortSignal;
};

export type ParallelSchedulerResult = {
  /** 所有子代理结果（含成功和失败），按提交顺序排列。 */
  results: AgentSubagentDelegationResult[];
  /** 每个任务的提交顺序索引。 */
  order: Map<string, number>;
  /** 冲突检测结果。 */
  conflicts: FileConflictReport[];
  /** 统计摘要。 */
  summary: ParallelRunSummary;
};

type FileConflictReport = {
  taskA: string;
  taskB: string;
  conflictingFiles: string[];
  severity: "info" | "warning" | "error";
  reason: string;
};

type ParallelRunSummary = {
  totalTasks: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  concurrentPeak: number;
  totalDurationMs: number;
  skippedByConflict: number;
};

/**
 * 阶段 6：并行调度 analysis 子代理。
 * 支持并发控制、文件冲突预检、取消传播。
 * implementation 子代理不参与并行（patch 冲突风险高）。
 */
export class SubagentParallelScheduler {
  private maxConcurrency: number;
  private parentRunId: string;
  private taskSessionId: string | null;
  private onAgentStep?: (step: AgentStep) => void;
  private parentSignal?: AbortSignal;
  /** 每个任务独立的 AbortController，父代理取消时全部终止。 */
  private taskControllers = new Map<string, AbortController>();
  /** 取消标志。 */
  private cancelled = false;

  constructor(options: ParallelSchedulerOptions) {
    this.maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.parentRunId = options.parentRunId;
    this.taskSessionId = options.taskSessionId;
    this.onAgentStep = options.onAgentStep;
    this.parentSignal = options.parentSignal;

    // 父代理取消时传播到所有子代理
    this.parentSignal?.addEventListener("abort", () => this.cancelAll(), { once: true });
  }

  /** 取消所有进行中的子代理任务。 */
  cancelAll() {
    this.cancelled = true;
    for (const controller of this.taskControllers.values()) {
      try { controller.abort(); } catch { /* ignore */ }
    }
  }

  /**
   * 并行执行多个 analysis 子代理任务。
   * 使用滑动窗口控制最大并发数。
   */
  async runParallel(tasks: ParallelSubagentTask[]): Promise<ParallelSchedulerResult> {
    const startedAt = Date.now();
    const results: (AgentSubagentDelegationResult | null)[] = new Array(tasks.length).fill(null);
    const order = new Map<string, number>();
    const conflicts: FileConflictReport[] = [];

    // 文件冲突预检：只分析 analysis 类型，只检测同文件冲突
    const fileConflictCheck = this.checkFileConflicts(tasks);
    conflicts.push(...fileConflictCheck);

    // 滑动窗口并发执行
    let activeCount = 0;
    let concurrentPeak = 0;
    let nextIndex = 0;
    const running = new Set<number>();

    const runTask = async (index: number): Promise<void> => {
      if (this.cancelled) return;

      const task = tasks[index];
      const delegationId = `pdel-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;
      const subagentId = `psub-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`;

      // 为每个任务创建独立的 AbortController
      const controller = new AbortController();
      this.taskControllers.set(subagentId, controller);

      // 父代理信号传播
      if (this.parentSignal?.aborted) {
        controller.abort();
      }

      const input: AgentSubagentDelegationInput = {
        title: task.title,
        kind: "analysis",
        goal: task.goal,
        expectedArtifactsKind: "analysis",
        scope: {
          allowedFilePaths: task.allowedFilePaths ?? [],
          allowedFileGlobs: task.allowedFileGlobs ?? [],
          allowedToolNames: [],
          canMutateWorkspace: false,
          canRequestApproval: false,
          canCompleteTask: true
        },
        budget: {
          maxSteps: task.maxSteps,
          maxReadFiles: task.maxFilesRead
        },
        hints: task.hints ?? []
      };

      order.set(delegationId, index);

      logAi(this.parentRunId, "subagent.parallel.taskStart", { delegationId, subagentId, index, title: task.title });

      try {
        const result = await runAnalysisSubagent({
          parentRunId: this.parentRunId,
          taskSessionId: this.taskSessionId,
          delegationId,
          subagentId,
          input,
          onAgentStep: this.onAgentStep,
          signal: controller.signal
        });

        results[index] = result;
        logAi(this.parentRunId, "subagent.parallel.taskEnd", { delegationId, subagentId, status: result.status, index });
      } catch (error) {
        if (controller.signal.aborted) {
          results[index] = {
            subagentId,
            parentRunId: this.parentRunId,
            delegationId,
            kind: "analysis",
            title: task.title,
            status: "cancelled",
            failure: {
              code: "SUBAGENT_CANCELLED",
              reason: this.cancelled ? "父代理终止，子代理被取消。" : "子代理被取消。",
              recoverable: false,
              suggestedAction: ""
            },
            runtime: {
              runId: "",
              mode: "plan",
              startedAt: Date.now(),
              finishedAt: Date.now(),
              durationMs: 0
            }
          };
        } else {
          results[index] = {
            subagentId,
            parentRunId: this.parentRunId,
            delegationId,
            kind: "analysis",
            title: task.title,
            status: "failed",
            failure: {
              code: "SUBAGENT_RUNTIME_ERROR",
              reason: error instanceof Error ? error.message : "unknown error",
              recoverable: true,
              suggestedAction: "父代理可缩小范围后单独重试该任务。"
            },
            runtime: {
              runId: "",
              mode: "plan",
              startedAt: Date.now(),
              finishedAt: Date.now(),
              durationMs: 0
            }
          };
        }
      } finally {
        this.taskControllers.delete(subagentId);
      }
    };

    // 滑动窗口调度
    while (nextIndex < tasks.length || activeCount > 0) {
      // 启动新任务直到达到最大并发数
      while (nextIndex < tasks.length && activeCount < this.maxConcurrency && !this.cancelled) {
        const index = nextIndex++;
        activeCount++;
        concurrentPeak = Math.max(concurrentPeak, activeCount);
        running.add(index);
        runTask(index).finally(() => {
          activeCount--;
          running.delete(index);
        });
      }

      // 等待任意任务完成
      if (activeCount > 0) {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (activeCount < this.maxConcurrency || this.cancelled) {
              clearInterval(check);
              resolve();
            }
          }, 50);
        });
      } else {
        break;
      }
    }

    // 等待所有任务完成
    while (activeCount > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    const finishedAt = Date.now();
    const finalResults = results.filter((r): r is AgentSubagentDelegationResult => r !== null);

    const summary: ParallelRunSummary = {
      totalTasks: tasks.length,
      succeeded: finalResults.filter((r) => r.status === "succeeded").length,
      failed: finalResults.filter((r) => r.status === "failed").length,
      cancelled: finalResults.filter((r) => r.status === "cancelled").length,
      concurrentPeak,
      totalDurationMs: finishedAt - startedAt,
      skippedByConflict: 0
    };

    logAi(this.parentRunId, "subagent.parallel.complete", summary);

    return { results: finalResults, order, conflicts, summary };
  }

  /**
   * 文件冲突预检：检测同文件/同目录冲突。
   * 只读 analysis 子代理无写盘操作，冲突仅作 warning 标记供父代理参考。
   */
  private checkFileConflicts(tasks: ParallelSubagentTask[]): FileConflictReport[] {
    const reports: FileConflictReport[] = [];
    const fileToTasks = new Map<string, string[]>();

    for (let i = 0; i < tasks.length; i++) {
      const paths = tasks[i].allowedFilePaths ?? [];
      for (const filePath of paths) {
        const existing = fileToTasks.get(filePath);
        if (existing) {
          for (const taskTitle of existing) {
            reports.push({
              taskA: taskTitle,
              taskB: tasks[i].title,
              conflictingFiles: [filePath],
              severity: "warning",
              reason: "并行 analysis 子代理读取同文件，结果可能重复但不互相污染。"
            });
          }
        }
        if (!fileToTasks.has(filePath)) {
          fileToTasks.set(filePath, []);
        }
        fileToTasks.get(filePath)!.push(tasks[i].title);
      }
    }

    // 同目录检测
    const dirToTasks = new Map<string, string[]>();
    for (let i = 0; i < tasks.length; i++) {
      const paths = tasks[i].allowedFilePaths ?? [];
      for (const filePath of paths) {
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (dir) {
          const existing = dirToTasks.get(dir);
          if (existing && !existing.includes(tasks[i].title)) {
            reports.push({
              taskA: existing[0],
              taskB: tasks[i].title,
              conflictingFiles: [dir],
              severity: "info",
              reason: "并行 analysis 子代理在同一目录下工作，注意结果去重。"
            });
          }
          if (!dirToTasks.has(dir)) {
            dirToTasks.set(dir, []);
          }
          if (!dirToTasks.get(dir)!.includes(tasks[i].title)) {
            dirToTasks.get(dir)!.push(tasks[i].title);
          }
        }
      }
    }

    return reports;
  }
}

/**
 * 便捷函数：并行运行 analysis 子代理。
 */
export async function runParallelAnalysisSubagents(
  tasks: ParallelSubagentTask[],
  options: ParallelSchedulerOptions
): Promise<ParallelSchedulerResult> {
  const scheduler = new SubagentParallelScheduler(options);
  return scheduler.runParallel(tasks);
}
