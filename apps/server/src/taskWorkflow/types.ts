export type TaskWorkflowType = "bugfix" | "feature" | "refactor" | "analysis-only";

export type TaskWorkflowSource = "intent" | "keyword" | "fallback";

export type TaskWorkflowStep = {
  id: string;
  title: string;
  description: string;
};

export type TaskWorkflowEvidence =
  | "workspace_read"
  | "pattern_search"
  | "pattern_candidate_read"
  | "existence_check"
  | "references_resolved"
  | "impact_analysis"
  | "command_attempt";

export type TaskWorkflowDecisionPolicy = {
  mutationAllowed: boolean;
  commandAllowed: boolean;
  requiredBeforeEdit: TaskWorkflowEvidence[];
  runtimeRules: string[];
};

export type TaskWorkflowDecision = {
  allowed: boolean;
  reason: string | null;
  missingEvidence: TaskWorkflowEvidence[];
  recommendedTools: string[];
};

export type TaskWorkflowEvidenceState = {
  workspaceRead: boolean;
  patternSearch: boolean;
  patternCandidateRead: boolean;
  existenceCheck: boolean;
  referencesResolved: boolean;
  impactAnalysis: boolean;
  commandAttempt: boolean;
};

export type TaskWorkflowAuthorization = {
  workspaceMutation: boolean;
  commandExecution: boolean;
  source: "workflow" | "user";
};

// 工作流快照会随任务会话持久化，保证历史任务能够解释当时采用的处理流程。
export type TaskWorkflowSnapshot = {
  type: TaskWorkflowType;
  source: TaskWorkflowSource;
  confidence: number;
  reason: string;
  authorization?: TaskWorkflowAuthorization;
  steps: TaskWorkflowStep[];
  version: number;
  selectedAt: number;
};
