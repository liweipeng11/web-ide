import { evaluateCommandPolicy } from "../../commandPolicy.js";
import type { AcceptanceEvidenceInput } from "../../agents/tester/contracts.js";
import { isPathInScope } from "../../runtime/permissionManager.js";
import { planVerification } from "../../verifier/index.js";
import type { VerificationPlan } from "../../verifier/types.js";
import { getWorkspaceRoot } from "../../workspaceStore.js";
import type { TesterGraphStateValue } from "./testerGraphState.js";

export interface VerificationPlanNodeDependencies {
  workspaceRoot: () => string | null;
  plan: (workspaceRoot: string, changedFiles: string[]) => Promise<VerificationPlan>;
  commandPolicy: typeof evaluateCommandPolicy;
}

const defaultDependencies: VerificationPlanNodeDependencies = {
  workspaceRoot: getWorkspaceRoot,
  plan: (workspaceRoot, changedFiles) => planVerification(workspaceRoot, null, { changedFiles }),
  commandPolicy: evaluateCommandPolicy
};

function normalizedPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function pathsOutsideScope(paths: string[], scope: string[]) {
  return paths.filter((filePath) => {
    try {
      return !isPathInScope(normalizedPath(filePath), scope);
    } catch {
      return true;
    }
  });
}

function pathsOutsidePatterns(paths: string[], patterns: string[]) {
  return paths.filter((filePath) => !patterns.some((pattern) => {
    try {
      return isPathInScope(normalizedPath(filePath), [pattern]);
    } catch {
      return false;
    }
  }));
}

function evidenceBlockers(state: TesterGraphStateValue) {
  const blockers: string[] = [];
  const criteria = new Set(state.task.acceptanceCriteria);
  const seen = new Set<string>();
  for (const item of state.acceptanceEvidence) {
    const criterion = item.criterion.trim();
    if (!criterion || !criteria.has(criterion)) blockers.push(`验收证据包含任务未声明的条件：${criterion || "<empty>"}`);
    if (seen.has(criterion)) blockers.push(`验收条件重复声明证据：${criterion}`);
    seen.add(criterion);
    const outsideTestScope = item.testFiles.filter((filePath) => !state.testScope.some((scope) => {
      try {
        return isPathInScope(normalizedPath(filePath), [scope]);
      } catch {
        return false;
      }
    }));
    if (outsideTestScope.length) blockers.push(`验收证据超出 testScope：${outsideTestScope.join("、")}`);
  }
  return blockers;
}

function inputBlockers(state: TesterGraphStateValue) {
  const blockers: string[] = [];
  if (state.task.type !== "test") blockers.push("Tester 只能规划 test Task。");
  if (state.task.writeScope.length) blockers.push("Tester Task 的 writeScope 必须为空。");
  const missingDependencies = state.task.dependencies.filter((taskId) => !state.completedTaskIds.includes(taskId));
  if (missingDependencies.length) blockers.push(`Tester Task 依赖尚未完成：${missingDependencies.join("、")}`);
  if (!state.graphRunId.trim()) blockers.push("graphRunId 不能为空。");
  if (!state.changedFiles.length) blockers.push("Tester 至少需要一个真实改动文件。");
  if (!state.testScope.length) blockers.push("Tester 至少需要一个明确 testScope。");
  const changedOutsideScope = pathsOutsideScope(state.changedFiles, state.task.readScope);
  if (changedOutsideScope.length) blockers.push(`改动文件超出 readScope：${changedOutsideScope.join("、")}`);
  const testScopeOutsideReadScope = pathsOutsideScope(state.testScope, state.task.readScope);
  if (testScopeOutsideReadScope.length) blockers.push(`testScope 超出 readScope：${testScopeOutsideReadScope.join("、")}`);
  blockers.push(...evidenceBlockers(state));
  return blockers;
}

function planBlockers(state: TesterGraphStateValue, plan: VerificationPlan, dependencies: VerificationPlanNodeDependencies) {
  const blockers: string[] = [];
  const expectedChanged = [...new Set(state.changedFiles.map(normalizedPath))].sort();
  const plannedChanged = [...new Set(plan.changedFiles.map(normalizedPath))].sort();
  if (JSON.stringify(expectedChanged) !== JSON.stringify(plannedChanged)) {
    blockers.push("验证计划的 changedFiles 与 Graph 输入不一致。");
  }
  const relatedOutsideScope = pathsOutsideScope(plan.relatedTests, state.task.readScope);
  if (relatedOutsideScope.length) blockers.push(`验证计划包含 readScope 外测试：${relatedOutsideScope.join("、")}`);
  const unrelatedTests = pathsOutsidePatterns(plan.relatedTests, state.testScope);
  if (unrelatedTests.length) blockers.push(`验证计划包含 testScope 外测试：${unrelatedTests.join("、")}`);
  if (!plan.commands.length) blockers.push("没有发现可执行的验证命令。");
  for (const command of plan.commands) {
    // Graph 只接受项目扫描或增量规划器生成的命令，不接受调用方注入的 preferred command。
    if (command.source === "request") blockers.push(`验证命令不能来自调用方注入：${command.name}`);
    const policy = dependencies.commandPolicy(command.command);
    if (policy.level !== "safe") blockers.push(`验证命令未通过安全白名单：${command.name}`);
  }
  return blockers;
}

/** 纯规划节点：生成并校验 VerificationPlan，不运行其中任何命令。 */
export async function prepareVerificationPlanNode(
  state: TesterGraphStateValue,
  dependencies: VerificationPlanNodeDependencies = defaultDependencies
): Promise<Partial<TesterGraphStateValue>> {
  const blockers = inputBlockers(state);
  if (blockers.length) return { status: "blocked", blockers, verificationPlan: null };

  const workspaceRoot = dependencies.workspaceRoot();
  if (!workspaceRoot) return { status: "blocked", blockers: ["运行 Tester 前必须打开工作区。"], verificationPlan: null };
  const plan = await dependencies.plan(workspaceRoot, [...state.changedFiles]);
  const plannedBlockers = planBlockers(state, plan, dependencies);
  if (plannedBlockers.length) return { status: "blocked", blockers: plannedBlockers, verificationPlan: plan };
  return { status: "plan_ready", blockers: [], verificationPlan: plan };
}

export type { AcceptanceEvidenceInput };
