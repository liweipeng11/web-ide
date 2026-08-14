import type { Agent, AgentContext, AgentTaskPacket } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import type {
  AcceptanceEvidenceInput,
  AcceptanceCriterionResult,
  TesterAgentResult,
  TesterCheckResult,
  TesterFailure,
  ValidationReport
} from "./contracts.js";
import { TESTER_TOOL_NAMES } from "./testerTools.js";
import type { VerificationExecution, VerificationIssue, VerificationReport } from "../../verifier/types.js";

type TesterTaskContext = {
  changedFiles: string[];
  testScope: string[];
  acceptanceEvidence: AcceptanceEvidenceInput[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown, field: string, maxItems = 200) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw runtimeError("INVALID_CONTRACT", `${field} 必须是非空字符串数组。`);
  }
  const normalized = [...new Set(value.map((item) => (item as string).trim()))];
  if (normalized.length > maxItems) throw runtimeError("INVALID_CONTRACT", `${field} 超过数量上限。`);
  return normalized;
}

function parseTaskContext(value: unknown): TesterTaskContext {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", "Tester Task context 必须是对象。");
  const acceptanceEvidence = Array.isArray(value.acceptanceEvidence)
    ? value.acceptanceEvidence.map((item) => {
        if (!isRecord(item) || typeof item.criterion !== "string" || !item.criterion.trim()) {
          throw runtimeError("INVALID_CONTRACT", "Tester acceptanceEvidence.criterion 不能为空。");
        }
        return {
          criterion: item.criterion.trim(),
          testFiles: stringArray(item.testFiles, "Tester acceptanceEvidence.testFiles")
        };
      })
    : [];
  return {
    changedFiles: stringArray(value.changedFiles, "Tester context.changedFiles"),
    testScope: stringArray(value.testScope, "Tester context.testScope"),
    acceptanceEvidence
  };
}

function isVerificationReport(value: unknown): value is VerificationReport {
  if (!isRecord(value)) return false;
  return ["success", "failed", "needs_confirmation", "blocked", "no_commands", "cancelled"].includes(String(value.status))
    && Array.isArray(value.executions)
    && isRecord(value.plan)
    && Array.isArray(value.plannedCommands);
}

function checkStatus(execution: VerificationExecution): TesterCheckResult["status"] {
  if (!execution.result) return execution.policy.level === "blocked" ? "blocked" : "not_run";
  return execution.result.status === "success" ? "passed" : "failed";
}

function toFailure(issue: VerificationIssue, execution: VerificationExecution): TesterFailure {
  return {
    category: issue.category,
    message: issue.message,
    command: execution.command.command,
    ...(issue.file ? { file: issue.file } : {}),
    ...(typeof issue.line === "number" ? { line: issue.line } : {}),
    ...(typeof issue.column === "number" ? { column: issue.column } : {}),
    ...(issue.code ? { code: issue.code } : {})
  };
}

export function toValidationReport(
  report: VerificationReport,
  criteria: string[],
  acceptanceEvidence: AcceptanceEvidenceInput[]
): ValidationReport {
  const checks: ValidationReport["checks"] = {};
  const failures: TesterFailure[] = [];
  const evidence: string[] = [];

  for (const execution of report.executions) {
    const status = checkStatus(execution);
    const check = {
      status,
      command: execution.command.command,
      exitCode: execution.result?.exitCode,
      issueCount: execution.issues.length
    };
    checks[execution.command.stage] = [...(checks[execution.command.stage] ?? []), check];
    const exitCode = typeof execution.result?.exitCode === "number" ? `，退出码 ${execution.result.exitCode}` : "";
    evidence.push(`${execution.command.command}：${status}${exitCode}`);
    failures.push(...execution.issues.map((issue) => toFailure(issue, execution)));
  }

  const passedTestCommands = report.executions
    .filter((execution) => execution.command.stage === "test" && execution.result?.status === "success")
    .map((execution) => execution.command.command);
  const failed = report.status === "failed" || report.status === "cancelled" || failures.length > 0;
  const evidenceByCriterion = new Map(acceptanceEvidence.map((item) => [item.criterion, item.testFiles]));
  const relatedTests = new Set(report.plan.relatedTests);
  const criterionResults: AcceptanceCriterionResult[] = criteria.map((criterion) => {
    const mappedTests = evidenceByCriterion.get(criterion) ?? [];
    const mappingVerified = mappedTests.length > 0 && mappedTests.every((filePath) => relatedTests.has(filePath));
    const status: AcceptanceCriterionResult["status"] = failed && mappingVerified
      ? "failed"
      : passedTestCommands.length && mappingVerified
        ? "passed"
        : "not_verified";
    return {
      criterion,
      status,
      evidence: status === "passed" ? [...passedTestCommands, ...mappedTests] : []
    };
  });
  const allCriteriaPassed = criterionResults.every((criterion) => criterion.status === "passed");

  return {
    status: report.status === "success" && passedTestCommands.length > 0 && allCriteriaPassed ? "passed" : "failed",
    checks,
    failures,
    acceptanceCriteria: criterionResults,
    evidence: [...new Set(evidence)],
    relatedTests: [...report.plan.relatedTests]
  };
}

export function blockersFor(report: VerificationReport, validation: ValidationReport) {
  if (report.status === "no_commands") return ["项目中没有发现可执行的验证命令。"];
  if (report.status === "needs_confirmation") return ["验证命令需要用户确认，Tester 不会自行扩大执行权限。"];
  if (report.status === "blocked") return ["验证命令被命令安全策略阻止。"];
  if (report.status === "cancelled") return ["验证命令已取消。"];
  if (report.status === "success" && validation.status !== "passed") return ["验证流水线没有执行成功的测试，无法证明业务验收条件已满足。"];
  return [];
}

/** Tester 是确定性只读 Agent：命令选择和成功状态均来自受控 verifier，不由模型自报。 */
export class TesterAgent implements Agent {
  readonly id = "tester";
  readonly capabilities = ["testing"];

  async run(task: AgentTaskPacket, context: AgentContext): Promise<TesterAgentResult> {
    if (task.writeScope.length) throw runtimeError("INVALID_CONTRACT", "Tester Task 的 writeScope 必须为空。");
    if (!task.acceptanceCriteria.length) throw runtimeError("INVALID_CONTRACT", "Tester Task 必须声明验收标准。");
    if (!task.allowedTools.includes(TESTER_TOOL_NAMES[0])) {
      throw runtimeError("PERMISSION_DENIED", "Tester Task 未授权 run_verification 工具。");
    }
    const taskContext = parseTaskContext(task.context);
    const duplicateCriteria = taskContext.acceptanceEvidence
      .map((item) => item.criterion)
      .filter((criterion, index, all) => all.indexOf(criterion) !== index);
    if (duplicateCriteria.length) {
      throw runtimeError("INVALID_CONTRACT", "acceptanceEvidence 不能重复声明同一验收条件。", { duplicateCriteria });
    }
    const outOfScopeEvidence = taskContext.acceptanceEvidence.flatMap((item) =>
      item.testFiles.filter((filePath) => !taskContext.testScope.some((pattern) => isPathInScope(filePath, [pattern])))
    );
    if (outOfScopeEvidence.length) {
      throw runtimeError("SCOPE_VIOLATION", "验收证据文件必须位于 testScope 内。", { outOfScopeEvidence });
    }
    const rawReport = await context.callTool("run_verification", {
      changedFiles: taskContext.changedFiles,
      testScope: taskContext.testScope
    });
    if (!isVerificationReport(rawReport)) {
      throw runtimeError("INVALID_CONTRACT", "run_verification 返回了无效报告。");
    }

    const declaredCriteria = new Set(task.acceptanceCriteria);
    const unknownCriteria = taskContext.acceptanceEvidence
      .map((item) => item.criterion)
      .filter((criterion) => !declaredCriteria.has(criterion));
    if (unknownCriteria.length) {
      throw runtimeError("INVALID_CONTRACT", "acceptanceEvidence 包含任务未声明的验收条件。", { unknownCriteria });
    }
    const validation = toValidationReport(rawReport, task.acceptanceCriteria, taskContext.acceptanceEvidence);
    const blockers = blockersFor(rawReport, validation);
    const status = rawReport.status === "failed"
      ? "failed"
      : validation.status === "passed"
        ? "success"
        : "blocked";
    const failedChecks = Object.entries(validation.checks)
      .filter(([, checks]) => checks?.some((check) => check.status === "failed"))
      .map(([stage]) => stage);

    return {
      taskId: task.taskId,
      status,
      summary: status === "success"
        ? "测试、静态检查和验收条件验证通过。"
        : status === "failed"
          ? `验证失败${failedChecks.length ? `：${failedChecks.join("、")}` : ""}。`
          : "验证未能形成足够的验收证据。",
      facts: validation.relatedTests.map((filePath) => `相关测试：${filePath}`),
      changedFiles: [],
      evidence: [...validation.evidence],
      blockers: status === "failed"
        ? validation.failures.map((failure) => failure.message).slice(0, 20)
        : blockers,
      validation
    };
  }
}
