import type { CommandPolicyResult, CommandResult } from "../types.js";
import type { ValidationCommandCandidate } from "../projectAnalyzerTypes.js";

// 验证阶段按成本从低到高排列，流水线会在首个失败处停止。
export type VerificationStage = "format_syntax" | "typecheck" | "lint" | "test" | "build";

export type VerificationIssueCategory = "syntax" | "type" | "lint" | "test" | "build" | "timeout" | "command" | "unknown";

export type VerificationCommand = ValidationCommandCandidate & {
  stage: VerificationStage;
};

export type VerificationIssue = {
  category: VerificationIssueCategory;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
};

export type VerificationExecution = {
  command: VerificationCommand;
  policy: CommandPolicyResult;
  result?: CommandResult;
  issues: VerificationIssue[];
};

export type VerificationReport = {
  status: "success" | "failed" | "needs_confirmation" | "blocked" | "no_commands" | "cancelled";
  plannedCommands: VerificationCommand[];
  plan: VerificationPlan;
  executions: VerificationExecution[];
  failedExecution?: VerificationExecution;
};

export type VerificationPlan = {
  mode: "full" | "incremental" | "package_fallback";
  commands: VerificationCommand[];
  changedFiles: string[];
  affectedPackages: string[];
  relatedTests: string[];
  buildRequired: boolean;
  reasons: string[];
  diagnostics: string[];
};

export type IncrementalVerificationInput = {
  changedFiles?: string[];
  failureCategories?: VerificationIssueCategory[];
};

export type RunVerificationOptions = {
  workspaceRoot: string;
  preferredCommand?: string | null;
  changedFiles?: string[];
  failureCategories?: VerificationIssueCategory[];
  confirmed?: boolean;
  signal?: AbortSignal;
};
