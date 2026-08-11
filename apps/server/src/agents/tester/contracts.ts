import type { AgentResult } from "../../runtime/contracts.js";
import type { VerificationIssueCategory, VerificationStage } from "../../verifier/types.js";

export type TesterCheckStatus = "passed" | "failed" | "blocked" | "not_run";

/** 单项验证结果只保存可审计摘要，不持久化完整命令输出。 */
export interface TesterCheckResult {
  status: TesterCheckStatus;
  command: string;
  exitCode?: number | null;
  issueCount: number;
}

export interface TesterFailure {
  category: VerificationIssueCategory;
  message: string;
  command?: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
}

export interface AcceptanceCriterionResult {
  criterion: string;
  status: "passed" | "failed" | "not_verified";
  evidence: string[];
}

/** Main/Planner 必须显式说明哪一个测试文件证明哪一条验收条件。 */
export interface AcceptanceEvidenceInput {
  criterion: string;
  testFiles: string[];
}

export interface ValidationReport {
  status: "passed" | "failed";
  checks: Partial<Record<VerificationStage, TesterCheckResult[]>>;
  failures: TesterFailure[];
  acceptanceCriteria: AcceptanceCriterionResult[];
  evidence: string[];
  relatedTests: string[];
}

/** Runtime 消费统一 AgentResult，validation 保存阶段 5 的结构化验证报告。 */
export interface TesterAgentResult extends AgentResult {
  validation: ValidationReport;
}

/** 任务历史只保存验证摘要和证据，不保存可能很大的 stdout/stderr。 */
export interface TesterArtifact {
  taskId: string;
  status: AgentResult["status"];
  summary: string;
  validation: ValidationReport;
  blockers: string[];
  createdAt: number;
}
