import type { Plan, Task, TaskType } from "../../runtime/contracts.js";
import { AgentRuntimeError, runtimeError } from "../../runtime/errors.js";
import { validatePlan } from "../../runtime/stateManager.js";
import type {
  PlannerCreatePlanInput,
  PlannerMissingContextResult,
  PlannerReplanInput,
  PlannerResult,
  PlannerScope
} from "./contracts.js";
import type { PlannerAgentDecisionModel } from "./plannerAgentModel.js";
import { ProviderPlannerAgentDecisionModel } from "./plannerAgentModel.js";
import { buildCreatePlanPrompt, buildReplanPrompt } from "./prompt.js";

const TASK_TYPES = new Set<TaskType>(["explore", "implement", "test", "respond"]);
export const PLANNER_LIMITS = {
  maxTasks: 30,
  maxDependenciesPerTask: 10,
  maxAcceptanceCriteriaPerTask: 10,
  maxPlanListItems: 20,
  maxTextLength: 1_000
} as const;

type TaskDraft = Pick<Task, "id" | "type" | "goal" | "dependencies" | "acceptanceCriteria">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(value: unknown, field: string, maxLength: number = PLANNER_LIMITS.maxTextLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw runtimeError("INVALID_CONTRACT", `${field} 不能为空。`, { field });
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw runtimeError("INVALID_CONTRACT", `${field} 超过长度上限 ${maxLength}。`, { field, maxLength });
  }
  return normalized;
}

function stringArray(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; maxItems?: number; maxLength?: number } = {}
) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw runtimeError("INVALID_CONTRACT", `${field} 必须是非空字符串数组。`, { field });
  }
  const result = [...new Set(value.map((item) => (item as string).trim()))];
  if (!options.allowEmpty && !result.length) {
    throw runtimeError("INVALID_CONTRACT", `${field} 至少需要一项。`, { field });
  }
  const maxItems = options.maxItems ?? PLANNER_LIMITS.maxPlanListItems;
  if (result.length > maxItems) {
    throw runtimeError("INVALID_CONTRACT", `${field} 超过数量上限 ${maxItems}。`, { field, maxItems });
  }
  const maxLength = options.maxLength ?? PLANNER_LIMITS.maxTextLength;
  if (result.some((item) => item.length > maxLength)) {
    throw runtimeError("INVALID_CONTRACT", `${field} 包含超过长度上限 ${maxLength} 的内容。`, { field, maxLength });
  }
  return result;
}

function validateInputScope(scope: PlannerScope) {
  return {
    readScope: stringArray(scope.readScope, "readScope", { allowEmpty: true }),
    writeScope: stringArray(scope.writeScope, "writeScope", { allowEmpty: true })
  };
}

function parseMissingContext(value: Record<string, unknown>): PlannerMissingContextResult {
  return {
    status: "missing_context",
    required: stringArray(value.required, "PlannerResult.required")
  };
}

function parseTaskDraft(value: unknown, index: number): TaskDraft {
  if (!isRecord(value)) {
    throw runtimeError("INVALID_CONTRACT", `Planner task ${index + 1} 格式无效。`, { index });
  }
  if (!TASK_TYPES.has(value.type as TaskType)) {
    throw runtimeError("INVALID_CONTRACT", `Planner task ${index + 1} 的 type 无效。`, { type: value.type });
  }
  return {
    id: requiredString(value.id, `tasks[${index}].id`, 80),
    type: value.type as TaskType,
    goal: requiredString(value.goal, `tasks[${index}].goal`),
    dependencies: stringArray(value.dependencies, `tasks[${index}].dependencies`, {
      allowEmpty: true,
      maxItems: PLANNER_LIMITS.maxDependenciesPerTask,
      maxLength: 80
    }),
    acceptanceCriteria: stringArray(value.acceptanceCriteria, `tasks[${index}].acceptanceCriteria`, {
      maxItems: PLANNER_LIMITS.maxAcceptanceCriteriaPerTask
    })
  };
}

function capabilitiesFor(type: TaskType) {
  if (type === "explore") return ["exploration"];
  if (type === "implement") return ["editing"];
  if (type === "test") return ["testing"];
  return ["respond"];
}

/** 模型只负责拆解任务；能力、状态和读写范围由代码按任务类型注入。 */
function materializeTask(draft: TaskDraft, scope: PlannerScope): Task {
  const canRead = draft.type !== "respond";
  const canWrite = draft.type === "implement";
  return {
    ...draft,
    requiredCapabilities: capabilitiesFor(draft.type),
    readScope: canRead ? [...scope.readScope] : [],
    writeScope: canWrite ? [...scope.writeScope] : [],
    status: "pending"
  };
}

function parseReadyPlan(
  value: Record<string, unknown>,
  goal: string,
  version: number,
  scope: PlannerScope,
  validateImmediately: boolean
): Plan {
  if (!isRecord(value.plan)) {
    throw runtimeError("INVALID_CONTRACT", "Planner ready 结果缺少 plan。");
  }
  const rawTasks = value.plan.tasks;
  if (!Array.isArray(rawTasks) || !rawTasks.length) {
    throw runtimeError("INVALID_CONTRACT", "Planner plan.tasks 至少需要一个任务。");
  }
  if (rawTasks.length > PLANNER_LIMITS.maxTasks) {
    throw runtimeError("INVALID_CONTRACT", `Planner plan.tasks 超过数量上限 ${PLANNER_LIMITS.maxTasks}。`, {
      maxTasks: PLANNER_LIMITS.maxTasks
    });
  }
  const plan: Plan = {
    version,
    // 目标和版本始终来自 Main，模型无权改写。
    goal,
    assumptions: stringArray(value.plan.assumptions, "Plan.assumptions", { allowEmpty: true }),
    tasks: rawTasks.map((task, index) => materializeTask(parseTaskDraft(task, index), scope)),
    completionCriteria: stringArray(value.plan.completionCriteria, "Plan.completionCriteria")
  };
  if (validateImmediately) validatePlan(plan);
  return plan;
}

function parseResult(
  value: unknown,
  goal: string,
  version: number,
  scope: PlannerScope,
  validateImmediately = true
): PlannerResult {
  if (!isRecord(value)) throw runtimeError("INVALID_CONTRACT", "Planner 返回了无效结果。");
  if (value.status === "missing_context") return parseMissingContext(value);
  if (value.status !== "ready") {
    throw runtimeError("INVALID_CONTRACT", `PlannerResult.status 无效：${String(value.status)}`);
  }
  return { status: "ready", plan: parseReadyPlan(value, goal, version, scope, validateImmediately) };
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

function preserveCompletedTasks(plan: Plan, input: PlannerReplanInput) {
  const oldTasks = new Map(input.oldPlan.tasks.map((task) => [task.id, task]));
  const completedIds = new Set([
    ...input.completedTasks,
    ...input.oldPlan.tasks.filter((task) => task.status === "completed").map((task) => task.id)
  ]);
  const unknownIds = [...completedIds].filter((taskId) => !oldTasks.has(taskId));
  if (unknownIds.length) {
    throw runtimeError("INVALID_CONTRACT", "completedTasks 包含旧计划中不存在的任务。", { unknownTaskIds: unknownIds });
  }

  const proposedById = new Map(plan.tasks.map((task) => [task.id, task]));
  const completed = [...completedIds].map((taskId) => ({ ...cloneTask(oldTasks.get(taskId)!), status: "completed" as const }));

  // 即使模型遗漏或篡改已完成任务，也使用旧计划中的可信快照恢复。
  plan.tasks = [
    ...plan.tasks.flatMap((task) => completedIds.has(task.id) ? [completed.find((item) => item.id === task.id)!] : [task]),
    ...completed.filter((task) => !proposedById.has(task.id))
  ];
  validatePlan(plan);
}

function failedResult(error: unknown, phase: "input" | "model"): PlannerResult {
  if (error instanceof AgentRuntimeError) {
    return {
      status: "failed",
      reason: phase === "input" ? "invalid_input" : "invalid_plan",
      blockers: [error.message]
    };
  }
  // Provider 和网络异常不向最终调用方暴露第三方内部信息或凭据。
  return {
    status: "failed",
    reason: "model_error",
    blockers: ["Planner 模型调用失败，请稍后重试。"]
  };
}

/** Planner 只生成或修改计划，不持有 Runtime 工具和共享状态写权限。 */
export class PlannerAgent {
  constructor(private readonly model: PlannerAgentDecisionModel = new ProviderPlannerAgentDecisionModel()) {}

  async createPlan(input: PlannerCreatePlanInput): Promise<PlannerResult> {
    let normalizedInput: PlannerCreatePlanInput;
    try {
      const goal = requiredString(input.goal, "goal");
      const scope = validateInputScope(input);
      normalizedInput = {
        ...input,
        goal,
        knownFacts: stringArray(input.knownFacts, "knownFacts", { allowEmpty: true }),
        constraints: stringArray(input.constraints, "constraints", { allowEmpty: true }),
        ...scope
      };
    } catch (error) {
      return failedResult(error, "input");
    }
    try {
      return parseResult(await this.model.createPlan(buildCreatePlanPrompt(normalizedInput)), normalizedInput.goal, 1, normalizedInput);
    } catch (error) {
      return failedResult(error, "model");
    }
  }

  async replan(input: PlannerReplanInput): Promise<PlannerResult> {
    let normalizedInput: PlannerReplanInput;
    try {
      validatePlan(input.oldPlan);
      const scope = validateInputScope(input);
      normalizedInput = {
        ...input,
        completedTasks: stringArray(input.completedTasks, "completedTasks", { allowEmpty: true }),
        newFacts: stringArray(input.newFacts, "newFacts", { allowEmpty: true }),
        constraints: stringArray(input.constraints, "constraints", { allowEmpty: true }),
        ...scope
      };
    } catch (error) {
      return failedResult(error, "input");
    }
    try {
      const result = parseResult(
        await this.model.replan(buildReplanPrompt(normalizedInput)),
        input.oldPlan.goal,
        input.oldPlan.version + 1,
        normalizedInput,
        // 重规划允许模型省略已完成节点，最终 DAG 在可信节点恢复后统一校验。
        false
      );
      if (result.status === "ready") preserveCompletedTasks(result.plan, normalizedInput);
      return result;
    } catch (error) {
      return failedResult(error, "model");
    }
  }
}
