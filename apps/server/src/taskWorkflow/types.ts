export type TaskWorkflowType = "bugfix" | "feature" | "refactor" | "analysis-only";

export type TaskWorkflowSource = "intent" | "keyword" | "fallback";

export type TaskWorkflowStep = {
  id: string;
  title: string;
  description: string;
};

// 工作流快照会随任务会话持久化，保证历史任务能够解释当时采用的处理流程。
export type TaskWorkflowSnapshot = {
  type: TaskWorkflowType;
  source: TaskWorkflowSource;
  confidence: number;
  reason: string;
  steps: TaskWorkflowStep[];
  version: number;
  selectedAt: number;
};
