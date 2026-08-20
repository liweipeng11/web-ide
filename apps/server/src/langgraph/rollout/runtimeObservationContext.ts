import { AsyncLocalStorage } from "node:async_hooks";
import type { ReadOnlyRuntimeMode, WriteRuntimeMode } from "./featureFlags.js";

export type RuntimeControlPlane = "legacy" | "langgraph" | "unknown";
export type RuntimeRolloutMode = ReadOnlyRuntimeMode | WriteRuntimeMode | "unknown";

export type RuntimeObservationContext = {
  controlPlane: RuntimeControlPlane;
  rolloutMode: RuntimeRolloutMode;
};

const storage = new AsyncLocalStorage<RuntimeObservationContext>();

/** 在并发请求之间隔离控制面来源，只传递固定枚举，不携带业务内容。 */
export function withRuntimeObservationContext<T>(context: RuntimeObservationContext, run: () => T): T {
  return storage.run(context, run);
}

export function getRuntimeObservationContext(): RuntimeObservationContext {
  return storage.getStore() ?? { controlPlane: "unknown", rolloutMode: "unknown" };
}
