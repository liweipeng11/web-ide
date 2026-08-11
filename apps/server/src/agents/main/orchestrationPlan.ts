import type { AcceptanceEvidenceInput } from "../tester/contracts.js";
import type { AgentResult, Plan, Task } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";
import { createAgentState, StateManager } from "../../runtime/stateManager.js";
import type { MainOrchestrationRequest } from "./orchestrationContracts.js";

export const DEFAULT_TEST_SCOPE = ["**/*.test.*", "**/*.spec.*", "**/tests/**", "**/__tests__/**"];

export function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** main_loop 不调用 Planner，只根据调用方给定的安全边界建立固定 implement → test DAG。 */
export function createMainLoopPlan(request: MainOrchestrationRequest): Plan {
  const goal = request.goal.trim();
  const readScope = uniqueStrings(request.readScope ?? []);
  const writeScope = uniqueStrings(request.writeScope ?? []);
  const testScope = uniqueStrings(request.testScope?.length ? request.testScope : DEFAULT_TEST_SCOPE);
  const acceptanceCriteria = uniqueStrings(request.acceptanceCriteria ?? []);

  if (!writeScope.length) {
    throw runtimeError("INVALID_CONTRACT", "中等代码修改必须显式提供 writeScope，Main 不能自行扩大写入范围。");
  }
  if (!acceptanceCriteria.length) {
    throw runtimeError("INVALID_CONTRACT", "中等代码修改至少需要一条验收标准。");
  }

  return {
    version: 1,
    goal,
    assumptions: [],
    tasks: [
      {
        id: "IMPLEMENT-1",
        type: "implement",
        goal,
        dependencies: [],
        requiredCapabilities: ["editing"],
        readScope: uniqueStrings([...readScope, ...writeScope]),
        writeScope,
        acceptanceCriteria,
        status: "pending"
      },
      {
        id: "TEST-1",
        type: "test",
        goal: `验证修改：${goal}`,
        dependencies: ["IMPLEMENT-1"],
        requiredCapabilities: ["testing"],
        readScope: uniqueStrings([...readScope, ...writeScope, ...testScope]),
        writeScope: [],
        acceptanceCriteria,
        status: "pending"
      }
    ],
    completionCriteria: acceptanceCriteria
  };
}

export function findRunnableTask(plan: Plan) {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return plan.tasks.find((task) =>
    task.status === "pending" && task.dependencies.every((dependency) => completed.has(dependency))
  );
}

/** 返回同一依赖快照下全部可运行任务，具体并发权限仍由 Orchestrator 决定。 */
export function findRunnableTasks(plan: Plan) {
  const completed = new Set(plan.tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return plan.tasks.filter((task) =>
    task.status === "pending" && task.dependencies.every((dependency) => completed.has(dependency))
  );
}

export function concreteTestFiles(task: Task) {
  return task.readScope.filter((filePath) =>
    !/[?*]/.test(filePath) && /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\./i.test(filePath)
  );
}

export function acceptanceEvidenceForTask(
  task: Task,
  supplied: AcceptanceEvidenceInput[] | undefined
): AcceptanceEvidenceInput[] {
  if (supplied?.length) {
    return supplied.filter((item) => task.acceptanceCriteria.includes(item.criterion));
  }
  const testFiles = concreteTestFiles(task);
  return testFiles.length
    ? task.acceptanceCriteria.map((criterion) => ({ criterion, testFiles: [...testFiles] }))
    : [];
}

/** respond Task 不调用工具，但仍通过统一状态机推进 Plan。 */
export function applyMainRespondTask(plan: Plan, task: Task): { plan: Plan; result: AgentResult } {
  const restored = createAgentState(plan.goal, plan);
  restored.completedTasks = plan.tasks.filter((item) => item.status === "completed").map((item) => item.id);
  const manager = new StateManager(restored);
  manager.startTask(task.id);
  const result: AgentResult = {
    taskId: task.id,
    status: "success",
    summary: task.goal,
    facts: [],
    changedFiles: [],
    evidence: ["main:respond"],
    blockers: []
  };
  manager.applyResult(result);
  const nextPlan = manager.getState().plan;
  if (!nextPlan) throw runtimeError("INVALID_CONTRACT", "Main respond Task 完成后缺少 Plan。");
  return { plan: nextPlan, result };
}
