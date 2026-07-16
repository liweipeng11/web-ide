import { AsyncLocalStorage } from "node:async_hooks";
import type { ModelSelection } from "./contracts/model.js";

export type ModelExecutionContext = {
  selection: ModelSelection;
  taskSessionId: string | null;
  mode: "chat" | "plan" | "act";
};

const storage = new AsyncLocalStorage<ModelExecutionContext>();

/** 将一次任务内的分类、计划、聊天和编辑请求绑定到同一模型。 */
export function withModelExecution<T>(context: ModelExecutionContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function getModelExecutionContext() {
  return storage.getStore();
}

export function getActiveModelId(fallback: string) {
  return storage.getStore()?.selection.modelId || fallback;
}
