import type { ReadOnlyRuntimeMode } from "./featureFlags.js";
import { getStableRolloutBucket } from "../../featureFlags.js";
import { runtimeError } from "../../runtime/errors.js";
import {
  compareShadowResults,
  shadowDurationBucket,
  type ShadowComparison,
  type ShadowResultDescriptor
} from "./shadowComparison.js";

export type ReadOnlyRuntimeSelection = {
  runLegacy: boolean;
  runNext: boolean;
  useNextResult: boolean;
};

export type ReadOnlyRuntimeObservation = {
  mode: ReadOnlyRuntimeMode;
  selected: "legacy" | "next";
  legacyStatus: "completed" | "failed" | "not_run";
  nextStatus: "completed" | "failed" | "not_run";
  equivalent?: boolean;
  /** 仅包含固定维度的匹配情况，不包含两条路径的原始值。 */
  comparison?: ShadowComparison;
  legacyDuration?: ReturnType<typeof shadowDurationBucket>;
  nextDuration?: ReturnType<typeof shadowDurationBucket>;
};

export function selectReadOnlyRuntime(input: {
  mode: ReadOnlyRuntimeMode;
  internalTask?: boolean;
  taskKey?: string;
  nextAvailable: boolean;
}): ReadOnlyRuntimeSelection {
  if (input.mode === "off") {
    return { runLegacy: true, runNext: false, useNextResult: false };
  }
  if (input.mode === "shadow") {
    if (!input.nextAvailable) {
      throw runtimeError("INVALID_CONTRACT", "只读运行模式为 shadow，但当前请求没有可用的 LangGraph 执行器。");
    }
    return { runLegacy: true, runNext: true, useNextResult: false };
  }
  if (input.mode === "internal") {
    if (!input.internalTask) return { runLegacy: true, runNext: false, useNextResult: false };
    if (!input.nextAvailable) {
      throw runtimeError("INVALID_CONTRACT", "内部任务已选择 LangGraph，但当前请求没有可用的 LangGraph 执行器。");
    }
    return { runLegacy: false, runNext: true, useNextResult: true };
  }

  // 百分比灰度必须绑定稳定任务键；未命中灰度属于明确选择 Legacy，并非运行中降级。
  const taskKey = input.taskKey?.trim();
  const threshold = input.mode === "10" ? 10 : input.mode === "50" ? 50 : input.mode === "all" ? 100 : 0;
  const selected = input.mode === "all" || Boolean(taskKey && getStableRolloutBucket(taskKey) < threshold);
  if (!selected) return { runLegacy: true, runNext: false, useNextResult: false };
  if (!input.nextAvailable) {
    throw runtimeError("INVALID_CONTRACT", "当前请求已选择 LangGraph，但没有可用的 LangGraph 执行器。");
  }
  return { runLegacy: false, runNext: true, useNextResult: true };
}

/**
 * 隔离执行只读新旧路径。观测只包含固定枚举和布尔值，不接收答案、Prompt、源码或工具输出。
 * 一旦选择新路径，Graph 失败会原样抛出，禁止同一请求静默切换到 Legacy。
 */
export async function executeReadOnlyRuntimeRollout<T>(input: {
  mode: ReadOnlyRuntimeMode;
  internalTask?: boolean;
  /** TaskSession ID 等稳定标识；百分比灰度不得使用每次请求变化的随机值。 */
  taskKey?: string;
  legacy: () => Promise<T>;
  next?: () => Promise<T>;
  equivalent?: (legacy: T, next: T) => boolean;
  describe?: (value: T) => ShadowResultDescriptor;
  observe?: (observation: ReadOnlyRuntimeObservation) => Promise<void> | void;
}): Promise<T> {
  const selection = selectReadOnlyRuntime({
    mode: input.mode,
    internalTask: input.internalTask,
    taskKey: input.taskKey,
    nextAvailable: Boolean(input.next)
  });

  if (!selection.runNext || !input.next) return input.legacy();

  if (!selection.runLegacy) {
    try {
      const nextValue = await input.next();
      await safeObserve(input.observe, { mode: input.mode, selected: "next", legacyStatus: "not_run", nextStatus: "completed" });
      return nextValue;
    } catch (error) {
      await safeObserve(input.observe, { mode: input.mode, selected: "next", legacyStatus: "not_run", nextStatus: "failed" });
      throw error;
    }
  }

  type TimedResult =
    | { ok: true; value: T; durationMs: number }
    | { ok: false; error: unknown; durationMs: number };
  const timed = async (execute: () => Promise<T>): Promise<TimedResult> => {
    const pathStartedAt = Date.now();
    try {
      return { ok: true, value: await execute(), durationMs: Date.now() - pathStartedAt };
    } catch (error) {
      return { ok: false, error, durationMs: Date.now() - pathStartedAt };
    }
  };
  const [legacyResult, nextResult] = await Promise.all([timed(input.legacy), timed(input.next)]);
  const comparison = legacyResult.ok && nextResult.ok && input.describe
    ? safeCompare(input.describe, legacyResult.value, nextResult.value)
    : undefined;
  const observation: ReadOnlyRuntimeObservation = {
    mode: input.mode,
    selected: "legacy",
    legacyStatus: legacyResult.ok ? "completed" : "failed",
    nextStatus: nextResult.ok ? "completed" : "failed",
    ...(input.describe ? {
      legacyDuration: shadowDurationBucket(legacyResult.durationMs),
      nextDuration: shadowDurationBucket(nextResult.durationMs),
      ...(comparison ? { comparison, equivalent: comparison.equivalent } : {})
    } : legacyResult.ok && nextResult.ok && input.equivalent
      ? { equivalent: safeEquivalent(input.equivalent, legacyResult.value, nextResult.value) }
      : {})
  };
  await safeObserve(input.observe, observation);
  if (!legacyResult.ok) throw legacyResult.error;
  return legacyResult.value;
}

async function safeObserve(
  observe: ((observation: ReadOnlyRuntimeObservation) => Promise<void> | void) | undefined,
  observation: ReadOnlyRuntimeObservation
): Promise<void> {
  try {
    await observe?.(observation);
  } catch {
    // 观测失败不能改变用户结果或触发新旧路径重跑。
  }
}

function safeCompare<T>(describe: (value: T) => ShadowResultDescriptor, legacy: T, next: T): ShadowComparison {
  try {
    return compareShadowResults(describe(legacy), describe(next));
  } catch {
    return { comparedDimensions: 0, differingDimensions: [], equivalent: false };
  }
}

function safeEquivalent<T>(equivalent: (legacy: T, next: T) => boolean, legacy: T, next: T): boolean {
  try {
    return equivalent(legacy, next);
  } catch {
    return false;
  }
}
