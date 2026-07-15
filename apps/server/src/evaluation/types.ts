import type { RunMetrics } from "../observability/index.js";

export type EvaluationScenarioId =
  | "single_file_type_fix"
  | "cross_file_contract_change"
  | "vue_component_type_sync"
  | "large_file_local_edit"
  | "long_terminal_output"
  | "unrelated_file_protection"
  | "dangerous_command_blocking"
  | "approval_resume"
  | "validation_retry"
  | "near_context_limit_summary";

export type EvaluationScenario = {
  id: EvaluationScenarioId;
  title: string;
  instruction: string;
  files: Record<string, string>;
  expected: {
    success: boolean;
    modifiedFiles?: string[];
    forbiddenFiles?: string[];
    dangerousCommandBlocked?: boolean;
    resumedAfterApproval?: boolean;
    validationAttempts?: number;
  };
};

export type EvaluationAgentResult = {
  success: boolean;
  modifiedFiles: string[];
  dangerousCommandBlocked: boolean;
  resumedAfterApproval: boolean;
  validationAttempts: number;
  metrics: RunMetrics;
};

export type EvaluationCaseReport = {
  scenarioId: EvaluationScenarioId;
  title: string;
  passed: boolean;
  failures: string[];
  result: EvaluationAgentResult;
};

export type EvaluationReport = {
  schemaVersion: 1;
  generatedAt: string;
  provider: "mock";
  summary: { total: number; passed: number; failed: number; successRate: number };
  cases: EvaluationCaseReport[];
};

