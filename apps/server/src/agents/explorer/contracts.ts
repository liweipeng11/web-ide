import type { AgentResult } from "../../runtime/contracts.js";

/** Explorer 输出的仓库事实；每项事实必须携带可追溯证据。 */
export interface ExplorerFact {
  statement: string;
  evidence: string[];
}

/** Main 和 Planner 可消费的压缩探索结果，不包含读取过的文件全文。 */
export interface ExplorerResult {
  summary: string;
  relevantFiles: string[];
  facts: ExplorerFact[];
  unknowns: string[];
}

/** 持久化到任务会话的探索制品，只保存结构化结论，不保存工具原始输出。 */
export interface ExplorerArtifact {
  taskId: string;
  result: ExplorerResult;
  createdAt: number;
}

export type ExplorerAction =
  | {
      type: "tool";
      tool: string;
      args: Record<string, unknown>;
    }
  | {
      type: "finish";
      result: ExplorerResult;
    };

/** Runtime 仍消费统一 AgentResult，ExplorerResult 作为只读结构化产物附带返回。 */
export interface ExplorerAgentResult extends AgentResult {
  exploration: ExplorerResult;
}
