import type { ReadOnlyRuntimeMode } from "./featureFlags.js";

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
};

export function selectReadOnlyRuntime(input: {
  mode: ReadOnlyRuntimeMode;
  internalTask?: boolean;
  nextAvailable: boolean;
}): ReadOnlyRuntimeSelection {
  if (!input.nextAvailable || input.mode === "off") {
    return { runLegacy: true, runNext: false, useNextResult: false };
  }
  if (input.mode === "shadow") {
    return { runLegacy: true, runNext: true, useNextResult: false };
  }
  return input.internalTask
    ? { runLegacy: false, runNext: true, useNextResult: true }
    : { runLegacy: true, runNext: false, useNextResult: false };
}

/**
 * 隔离执行只读新旧路径。观测只包含固定枚举和布尔值，不接收答案、Prompt、源码或工具输出。
 * internal 新路径失败时自动执行 Legacy，保证内部验证不会把失败扩散到用户结果。
 */
export async function executeReadOnlyRuntimeRollout<T>(input: {
  mode: ReadOnlyRuntimeMode;
  internalTask?: boolean;
  legacy: () => Promise<T>;
  next?: () => Promise<T>;
  equivalent?: (legacy: T, next: T) => boolean;
  observe?: (observation: ReadOnlyRuntimeObservation) => void;
}): Promise<T> {
  const selection = selectReadOnlyRuntime({
    mode: input.mode,
    internalTask: input.internalTask,
    nextAvailable: Boolean(input.next)
  });

  if (!selection.runNext || !input.next) return input.legacy();

  if (!selection.runLegacy) {
    try {
      const nextValue = await input.next();
      safeObserve(input.observe, { mode: input.mode, selected: "next", legacyStatus: "not_run", nextStatus: "completed" });
      return nextValue;
    } catch {
      const legacyValue = await input.legacy();
      safeObserve(input.observe, { mode: input.mode, selected: "legacy", legacyStatus: "completed", nextStatus: "failed" });
      return legacyValue;
    }
  }

  const [legacyResult, nextResult] = await Promise.allSettled([input.legacy(), input.next()]);
  const observation: ReadOnlyRuntimeObservation = {
    mode: input.mode,
    selected: "legacy",
    legacyStatus: legacyResult.status === "fulfilled" ? "completed" : "failed",
    nextStatus: nextResult.status === "fulfilled" ? "completed" : "failed",
    ...(legacyResult.status === "fulfilled" && nextResult.status === "fulfilled" && input.equivalent
      ? { equivalent: safeEquivalent(input.equivalent, legacyResult.value, nextResult.value) }
      : {})
  };
  safeObserve(input.observe, observation);
  if (legacyResult.status === "rejected") throw legacyResult.reason;
  return legacyResult.value;
}

function safeObserve(
  observe: ((observation: ReadOnlyRuntimeObservation) => void) | undefined,
  observation: ReadOnlyRuntimeObservation
): void {
  try {
    observe?.(observation);
  } catch {
    // 观测失败不能改变用户结果或触发新旧路径重跑。
  }
}

function safeEquivalent<T>(equivalent: (legacy: T, next: T) => boolean, legacy: T, next: T): boolean {
  try {
    return equivalent(legacy, next);
  } catch {
    return false;
  }
}
