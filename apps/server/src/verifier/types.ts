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
  status: "success" | "failed" | "needs_confirmation" | "blocked" | "no_commands";
  plannedCommands: VerificationCommand[];
  executions: VerificationExecution[];
  failedExecution?: VerificationExecution;
};

export type RunVerificationOptions = {
  workspaceRoot: string;
  preferredCommand?: string | null;
  confirmed?: boolean;
};
