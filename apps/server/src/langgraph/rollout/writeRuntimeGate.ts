import { getStableRolloutBucket } from "../../featureFlags.js";
import { runtimeError } from "../../runtime/errors.js";
import type { TaskSession } from "../../types.js";
import type { WriteRuntimeMode } from "./featureFlags.js";

export type WriteRuntimeSelection = "legacy" | "graph";

export type WriteRuntimeSafetyReason =
  | "unapproved_write"
  | "scope_violation"
  | "duplicate_side_effect"
  | "state_corruption"
  | "incorrect_completion"
  | "recovery_failure"
  | "runtime_failure";

export type TaskSideEffectSnapshot = {
  filesChanged: string[];
  appliedFilePaths: string[];
  checkpointIds: string[];
  commandsRun: string[];
};

export interface WriteRuntimeGate {
  isOpen(): boolean;
  reason(): WriteRuntimeSafetyReason | undefined;
  trip(reason: WriteRuntimeSafetyReason): void;
}

/**
 * 写路径熔断器只保存脱敏原因，不保存源码、命令或工具输出。
 * 进程内一旦触发，后续本应选择 Graph 的任务直接失败；只有明确关闭 Graph 的配置才会选择 Legacy。
 */
export class InMemoryWriteRuntimeGate implements WriteRuntimeGate {
  private openedBy: WriteRuntimeSafetyReason | undefined;

  isOpen() {
    return Boolean(this.openedBy);
  }

  reason() {
    return this.openedBy;
  }

  trip(reason: WriteRuntimeSafetyReason) {
    this.openedBy ??= reason;
  }
}

export const defaultWriteRuntimeGate = new InMemoryWriteRuntimeGate();

/** shadow 不重复执行真实写任务，只保留 Legacy；百分比模式必须绑定稳定 TaskSession ID。 */
export function selectWriteRuntime(input: {
  enabled: boolean;
  mode: WriteRuntimeMode;
  taskKey: string;
  internalTask?: boolean;
  gateOpen?: boolean;
}): WriteRuntimeSelection {
  // 总开关关闭、off 和 shadow 都是请求开始前明确选择 Legacy，不属于 Graph 运行中降级。
  if (!input.enabled || input.mode === "off" || input.mode === "shadow") return "legacy";

  let selected = false;
  if (input.mode === "all") {
    if (!input.taskKey.trim()) {
      throw runtimeError("INVALID_CONTRACT", "写运行模式为 all 时必须提供稳定的 TaskSession ID。");
    }
    selected = true;
  } else if (input.mode === "internal") {
    selected = Boolean(input.internalTask);
  } else {
    const taskKey = input.taskKey.trim();
    if (taskKey) {
      const threshold = input.mode === "10" ? 10 : 50;
      selected = getStableRolloutBucket(taskKey) < threshold;
    }
  }

  if (!selected) return "legacy";
  if (input.gateOpen) {
    throw runtimeError("INVALID_STATE_TRANSITION", "当前写任务已选择 LangGraph，但安全门已熔断。");
  }
  return "graph";
}

/** 捕获回退判断所需的最小副作用事实，不复制完整 TaskSession。 */
export function snapshotTaskSideEffects(session: TaskSession): TaskSideEffectSnapshot {
  return {
    filesChanged: [...session.filesChanged],
    appliedFilePaths: [...(session.runtimeEvidence?.appliedFilePaths ?? [])],
    checkpointIds: [...session.checkpointIds],
    commandsRun: [...session.commandsRun]
  };
}

function containsNewValue(before: string[], after: string[]) {
  const known = new Set(before);
  return after.some((value) => !known.has(value));
}

/** 比较任务副作用快照，供安全审计和重复执行防护使用；不得据此把 Graph 请求降级为 Legacy。 */
export function hasNewTaskSideEffects(before: TaskSideEffectSnapshot, after: TaskSideEffectSnapshot) {
  return containsNewValue(before.filesChanged, after.filesChanged)
    || containsNewValue(before.appliedFilePaths, after.appliedFilePaths)
    || containsNewValue(before.checkpointIds, after.checkpointIds)
    || containsNewValue(before.commandsRun, after.commandsRun);
}
