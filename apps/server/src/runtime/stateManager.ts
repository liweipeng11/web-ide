import type { AgentResult, AgentState, Plan, Task, TaskStatus } from "./contracts.js";
import { runtimeError } from "./errors.js";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "failed"]);

const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["running", "blocked"],
  running: ["completed", "failed", "blocked"],
  blocked: ["pending", "running", "failed"],
  completed: [],
  failed: []
};

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    dependencies: [...task.dependencies],
    requiredCapabilities: [...task.requiredCapabilities],
    readScope: [...task.readScope],
    writeScope: [...task.writeScope],
    acceptanceCriteria: [...task.acceptanceCriteria]
  };
}

function clonePlan(plan: Plan): Plan {
  return {
    ...plan,
    assumptions: [...plan.assumptions],
    completionCriteria: [...plan.completionCriteria],
    tasks: plan.tasks.map(cloneTask)
  };
}

export function cloneAgentState(state: AgentState): AgentState {
  return {
    ...state,
    plan: state.plan ? clonePlan(state.plan) : undefined,
    completedTasks: [...state.completedTasks],
    failedTasks: [...state.failedTasks],
    changedFiles: [...state.changedFiles],
    facts: [...state.facts]
  };
}

function assertNonEmpty(value: string, field: string) {
  if (!value.trim()) {
    throw runtimeError("INVALID_CONTRACT", `${field} 不能为空。`, { field });
  }
}

/** 在 Runtime 接收计划时验证结构、依赖引用和有向无环约束。 */
export function validatePlan(plan: Plan) {
  if (!Number.isInteger(plan.version) || plan.version < 1) {
    throw runtimeError("INVALID_CONTRACT", "Plan.version 必须是正整数。", { version: plan.version });
  }
  assertNonEmpty(plan.goal, "Plan.goal");
  if (!plan.tasks.length) {
    throw runtimeError("INVALID_CONTRACT", "Plan.tasks 至少需要包含一个任务。");
  }
  if (!plan.completionCriteria.some((criterion) => criterion.trim())) {
    throw runtimeError("INVALID_CONTRACT", "Plan.completionCriteria 至少需要包含一条完成标准。");
  }

  const taskIds = new Set<string>();
  for (const task of plan.tasks) {
    assertNonEmpty(task.id, "Task.id");
    assertNonEmpty(task.goal, `Task(${task.id}).goal`);
    if (taskIds.has(task.id)) {
      throw runtimeError("INVALID_CONTRACT", `Task ID 重复：${task.id}`, { taskId: task.id });
    }
    if (!task.acceptanceCriteria.some((criterion) => criterion.trim())) {
      throw runtimeError("INVALID_CONTRACT", `Task ${task.id} 至少需要包含一条验收标准。`, { taskId: task.id });
    }
    taskIds.add(task.id);
  }

  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        throw runtimeError("INVALID_CONTRACT", `Task ${task.id} 引用了不存在的依赖 ${dependency}。`, {
          taskId: task.id,
          dependency
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const visit = (taskId: string) => {
    if (visiting.has(taskId)) {
      throw runtimeError("INVALID_CONTRACT", `Plan 存在循环依赖：${taskId}`, { taskId });
    }
    if (visited.has(taskId)) return;

    visiting.add(taskId);
    for (const dependency of tasksById.get(taskId)?.dependencies ?? []) visit(dependency);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of taskIds) visit(taskId);
}

export function createAgentState(goal: string, plan?: Plan): AgentState {
  assertNonEmpty(goal, "AgentState.goal");
  if (plan) validatePlan(plan);

  return {
    goal: goal.trim(),
    plan: plan ? clonePlan(plan) : undefined,
    completedTasks: [],
    failedTasks: [],
    changedFiles: [],
    facts: [],
    status: "running"
  };
}

/** 集中维护任务状态机，Agent 不得直接修改共享状态。 */
export class StateManager {
  private state: AgentState;

  constructor(initialState: AgentState) {
    if (initialState.plan) validatePlan(initialState.plan);
    this.state = cloneAgentState(initialState);
  }

  getState() {
    return cloneAgentState(this.state);
  }

  getTask(taskId: string) {
    const task = this.state.plan?.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw runtimeError("TASK_NOT_FOUND", `未找到任务：${taskId}`, { taskId });
    return cloneTask(task);
  }

  transitionTask(taskId: string, nextStatus: TaskStatus) {
    const task = this.state.plan?.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw runtimeError("TASK_NOT_FOUND", `未找到任务：${taskId}`, { taskId });
    if (!ALLOWED_TASK_TRANSITIONS[task.status].includes(nextStatus)) {
      throw runtimeError("INVALID_STATE_TRANSITION", `任务 ${taskId} 不能从 ${task.status} 流转到 ${nextStatus}。`, {
        taskId,
        currentStatus: task.status,
        nextStatus
      });
    }
    task.status = nextStatus;
  }

  startTask(taskId: string) {
    const task = this.getTask(taskId);
    const incompleteDependencies = task.dependencies.filter((dependency) => !this.state.completedTasks.includes(dependency));
    if (incompleteDependencies.length) {
      throw runtimeError("TASK_DEPENDENCY_NOT_SATISFIED", `任务 ${taskId} 的依赖尚未完成。`, {
        taskId,
        incompleteDependencies
      });
    }

    this.transitionTask(taskId, "running");
    this.state.currentTask = taskId;
    this.state.status = "running";
  }

  applyResult(result: AgentResult) {
    const task = this.getTask(result.taskId);
    if (task.status !== "running") {
      throw runtimeError("INVALID_STATE_TRANSITION", `只能向 running 状态的任务应用结果：${result.taskId}`, {
        taskId: result.taskId,
        currentStatus: task.status
      });
    }

    const nextStatus: TaskStatus = result.status === "success" ? "completed" : result.status;
    this.transitionTask(result.taskId, nextStatus);
    this.state.changedFiles = uniqueStrings([...this.state.changedFiles, ...result.changedFiles]);
    this.state.facts = uniqueStrings([...this.state.facts, ...result.facts]);
    this.state.currentTask = undefined;

    if (result.status === "success") {
      this.state.completedTasks = uniqueStrings([...this.state.completedTasks, result.taskId]);
      const allCompleted = this.state.plan?.tasks.every((item) => item.status === "completed") ?? true;
      this.state.status = allCompleted ? "completed" : "running";
      return;
    }

    if (result.status === "failed") {
      this.state.failedTasks = uniqueStrings([...this.state.failedTasks, result.taskId]);
      this.state.status = "failed";
      return;
    }

    this.state.status = "waiting_user";
  }

  isTerminal() {
    return this.state.plan?.tasks.every((task) => TERMINAL_TASK_STATUSES.has(task.status)) ?? false;
  }
}
