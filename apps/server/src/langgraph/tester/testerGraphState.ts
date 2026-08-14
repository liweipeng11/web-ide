import { Annotation } from "@langchain/langgraph";
import type { AcceptanceEvidenceInput, ValidationReport } from "../../agents/tester/contracts.js";
import type { Task } from "../../runtime/contracts.js";
import type { VerificationPlan } from "../../verifier/types.js";

export type TesterGraphStatus = "pending" | "plan_ready" | "blocked" | "running" | "passed" | "failed";
export type TesterFailureClass = "none" | "implementation" | "plan" | "environment" | "cancelled";

function replaceStrings(_current: string[], update: string[]) {
  return [...new Set(update.map((value) => value.trim()).filter(Boolean))];
}

function replaceEvidence(_current: AcceptanceEvidenceInput[], update: AcceptanceEvidenceInput[]) {
  return update.map((item) => ({
    criterion: item.criterion.trim(),
    testFiles: [...new Set(item.testFiles.map((filePath) => filePath.trim()).filter(Boolean))]
  }));
}

/** Tester Graph 只保存流程所需摘要，命令输出和源码正文不进入 checkpoint。 */
export const TesterGraphState = Annotation.Root({
  task: Annotation<Task>,
  graphRunId: Annotation<string>,
  completedTaskIds: Annotation<string[]>({ reducer: replaceStrings, default: () => [] }),
  changedFiles: Annotation<string[]>({ reducer: replaceStrings, default: () => [] }),
  testScope: Annotation<string[]>({ reducer: replaceStrings, default: () => [] }),
  acceptanceEvidence: Annotation<AcceptanceEvidenceInput[]>({ reducer: replaceEvidence, default: () => [] }),
  status: Annotation<TesterGraphStatus>,
  verificationPlan: Annotation<VerificationPlan | null>,
  validation: Annotation<ValidationReport | null>,
  failureClass: Annotation<TesterFailureClass>,
  blockers: Annotation<string[]>({ reducer: replaceStrings, default: () => [] })
});

export type TesterGraphStateValue = typeof TesterGraphState.State;

export function createTesterGraphState(input: {
  task: Task;
  graphRunId: string;
  completedTaskIds: string[];
  changedFiles: string[];
  testScope: string[];
  acceptanceEvidence?: AcceptanceEvidenceInput[];
}): TesterGraphStateValue {
  return {
    task: input.task,
    graphRunId: input.graphRunId.trim(),
    completedTaskIds: [...input.completedTaskIds],
    changedFiles: [...input.changedFiles],
    testScope: [...input.testScope],
    acceptanceEvidence: input.acceptanceEvidence?.map((item) => ({ ...item, testFiles: [...item.testFiles] })) ?? [],
    status: "pending",
    verificationPlan: null,
    validation: null,
    failureClass: "none",
    blockers: []
  };
}
