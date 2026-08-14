import { blockersFor, toValidationReport } from "../../agents/tester/testerAgent.js";
import { executeVerificationPlan } from "../../verifier/verifier.js";
import type { VerificationReport } from "../../verifier/types.js";
import type { TesterFailureClass, TesterGraphStateValue } from "./testerGraphState.js";

export interface VerificationExecutionNodeDependencies {
  execute: (plan: NonNullable<TesterGraphStateValue["verificationPlan"]>, signal?: AbortSignal) => Promise<VerificationReport>;
}

const defaultDependencies: VerificationExecutionNodeDependencies = {
  execute: (plan, signal) => executeVerificationPlan(plan, { confirmed: false, signal })
};

function classifyFailure(report: VerificationReport, validationStatus: "passed" | "failed"): TesterFailureClass {
  if (report.status === "cancelled") return "cancelled";
  if (["blocked", "needs_confirmation", "no_commands"].includes(report.status)) return "environment";
  if (report.status === "success" && validationStatus === "failed") return "plan";
  if (report.status === "failed") {
    const categories = new Set(report.executions.flatMap((execution) => execution.issues.map((issue) => issue.category)));
    if (categories.has("timeout") || categories.has("command") || categories.has("unknown")) return "environment";
    return "implementation";
  }
  return "none";
}

/** 执行 7A 已冻结的验证计划，并只把有界摘要写回 Graph state。 */
export async function executeVerificationNode(
  state: TesterGraphStateValue,
  dependencies: VerificationExecutionNodeDependencies = defaultDependencies,
  signal?: AbortSignal
): Promise<Partial<TesterGraphStateValue>> {
  if (state.status !== "plan_ready" || !state.verificationPlan) {
    return {
      status: "blocked",
      failureClass: "plan",
      blockers: ["Tester 必须先完成验证计划门禁。"]
    };
  }

  const report = await dependencies.execute(state.verificationPlan, signal);
  const validation = toValidationReport(report, state.task.acceptanceCriteria, state.acceptanceEvidence);
  const failureClass = classifyFailure(report, validation.status);
  const blockers = blockersFor(report, validation);
  if (report.status === "failed" && !blockers.length) {
    blockers.push(...validation.failures.map((failure) => failure.message).slice(0, 20));
  }
  return {
    status: validation.status === "passed" ? "passed" : report.status === "failed" ? "failed" : "blocked",
    validation,
    failureClass,
    blockers
  };
}
