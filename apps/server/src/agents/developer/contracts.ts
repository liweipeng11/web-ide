import type { AgentResult } from "../../runtime/contracts.js";

export type DeveloperPatchOperation = "replace" | "create";

/** Developer 写工具返回的最小事实，避免把完整源码重复带回模型上下文。 */
export interface DeveloperPatchResult {
  filePath: string;
  operation: DeveloperPatchOperation;
  changed: boolean;
  replacements?: number;
  checkpointId?: string;
}

export interface DeveloperCompletion {
  summary: string;
  facts: string[];
  evidence: string[];
}

export type DeveloperAction =
  | {
      type: "tool";
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      type: "finish";
      result: DeveloperCompletion;
    }
  | {
      type: "request_scope_change";
      reason: string;
      requiredScope: string[];
    };

/** Runtime 消费统一 AgentResult；implementation 仅保存本次实现的结构化摘要。 */
export interface DeveloperAgentResult extends AgentResult {
  implementation?: DeveloperCompletion;
  checkpointIds?: string[];
}

/** 任务会话只保存实现摘要和可恢复证据，不持久化模型观察到的源码正文。 */
export interface DeveloperArtifact {
  taskId: string;
  status: AgentResult["status"];
  summary: string;
  changedFiles: string[];
  evidence: string[];
  blockers: string[];
  checkpointIds: string[];
  scopeChangeRequest?: AgentResult["scopeChangeRequest"];
  createdAt: number;
}
