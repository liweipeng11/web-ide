import type { Agent, AgentContext, AgentResult, AgentTaskPacket, Plan, RuntimeToolDescriptor, Task, TaskType } from "../../runtime/contracts.js";
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
import { EXPLORER_TOOL_NAMES } from "../explorer/explorerTools.js";
import { recoverableToolObservation } from "../toolRecovery.js";
import { buildCreatePlanPrompt, buildPlannerToolPrompt, buildReplanPrompt } from "./prompt.js";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 当前文件所在目录（ESM 下用 import.meta.url 推导，避免依赖 __dirname）。
const PLANNER_CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

const TASK_TYPES = new Set<TaskType>(["explore", "implement", "test", "respond"]);

// Planner 专属 debug 日志：
// - 仅在环境变量 PLANNER_DEBUG=1 时启用，避免污染生产日志与文件 IO；
// - 日志按天滚动写入文件（默认 server 包根下的 logs/planner-debug-YYYY-MM-DD.log），
//   可通过 PLANNER_LOG_DIR 覆盖目录，避免硬编码路径。
const PLANNER_DEBUG_ENABLED = process.env.PLANNER_DEBUG === "1" || process.env.PLANNER_DEBUG === "true";
const PLANNER_LOG_DIR = process.env.PLANNER_LOG_DIR
  ? path.resolve(process.env.PLANNER_LOG_DIR)
  : path.resolve(PLANNER_CURRENT_DIR, "..", "..", "logs");

// 缓存当天的日志文件路径，跨调用复用，避免重复拼装。
let plannerLogFile: string | null = null;
function resolvePlannerLogFile(): string {
  if (!plannerLogFile) {
    const day = new Date().toISOString().slice(0, 10);
    plannerLogFile = path.join(PLANNER_LOG_DIR, `planner-debug-${day}.log`);
  }
  return plannerLogFile;
}

// 将一条 debug 日志异步追加到文件，失败仅告警不影响主流程。
async function writePlannerLogFile(line: string): Promise<void> {
  try {
    await mkdir(PLANNER_LOG_DIR, { recursive: true });
    await appendFile(resolvePlannerLogFile(), line + "\n", "utf8");
  } catch (error) {
    console.warn(`[planner:debug] 写入日志文件失败：${(error as Error).message}`);
  }
}

function debugPlanner(message: string, detail?: unknown): void {
  if (!PLANNER_DEBUG_ENABLED) return;
  // 写入文件（含时间戳与可选结构化详情）。
  const timestamp = new Date().toISOString();
  const payload = detail === undefined ? message : `${message} ${safeStringify(detail)}`;
  void writePlannerLogFile(`[${timestamp}] [planner:debug] ${payload}`);
}

// 将详情安全地序列化：循环引用或不可序列化对象降级为字符串，避免日志写入抛错。
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const PLANNER_LIMITS = {
  maxTasks: 30,
  maxDependenciesPerTask: 10,
  maxAcceptanceCriteriaPerTask: 10,
  maxPlanListItems: 20,
  maxTextLength: 1_000
} as const;

type TaskDraft = Pick<Task, "id" | "type" | "goal" | "dependencies" | "acceptanceCriteria">;

type PlannerToolAction = { type: "tool"; tool: string; args: Record<string, unknown> };
type PlannerRunContext = { phase: "create" | "replan"; request: PlannerCreatePlanInput | PlannerReplanInput };
export type PlannerAgentResult = AgentResult & { planning: PlannerResult };
const PLANNER_READ_TOOL_NAMES = new Set<string>(EXPLORER_TOOL_NAMES);
// 读取次数与模型决策次数分开限制：最后一次读取后仍须给模型机会产出计划。
const MAX_PLANNER_READ_TOOL_CALLS = 30;
const MAX_PLANNER_FINALIZATION_STEPS = 4;
const MAX_PLANNER_OBSERVATION_CHARS = 20_000;

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

/**
 * 模型在探索预算耗尽后仍不收敛时，生成一个保守的最小计划，避免整个任务因模型循环而丢失。
 */
function createFallbackPlan(
  request: PlannerCreatePlanInput | PlannerReplanInput,
  phase: "create" | "replan",
  observations: Array<{ tool: string; result: unknown }>
): PlannerResult {
  const goal = phase === "create" ? (request as PlannerCreatePlanInput).goal : (request as PlannerReplanInput).oldPlan.goal;
  const scope = request as PlannerScope;
  const evidenceCount = observations.filter((observation) => observation.tool !== "planner_policy").length;
  const fallback = parseResult({
    status: "ready",
    plan: {
      assumptions: [
        `Planner 已收集 ${evidenceCount} 次只读观察；未完成的细节由实现任务继续确认。`,
        "实现任务应先确认目标文件和目录存在性，再执行写入。"
      ],
      tasks: [
        {
          id: "T1",
          type: "explore",
          goal: `基于已收集证据确认与“${goal}”相关的文件、依赖和现有实现。`,
          dependencies: [],
          acceptanceCriteria: ["相关文件和依赖已记录", "未确认的细节已明确标注"]
        },
        {
          id: "T2",
          type: "implement",
          goal: goal,
          dependencies: ["T1"],
          acceptanceCriteria: ["目标功能已实现", "实现范围符合 readScope 和 writeScope"]
        },
        {
          id: "T3",
          type: "test",
          goal: "验证实现结果、边界场景及相关构建或测试命令。",
          dependencies: ["T2"],
          acceptanceCriteria: ["相关验证已执行", "发现的问题已修复或明确记录"]
        },
        {
          id: "T4",
          type: "respond",
          goal: "汇总变更文件、验证结果和剩余假设。",
          dependencies: ["T3"],
          acceptanceCriteria: ["交付说明完整"]
        }
      ],
      completionCriteria: ["目标功能完成并通过相关验证", "变更和剩余风险已说明"]
    }
  }, goal, phase === "create" ? 1 : (request as PlannerReplanInput).oldPlan.version + 1, scope, phase === "create");
  if (phase === "replan" && fallback.status === "ready") preserveCompletedTasks(fallback.plan, request as PlannerReplanInput);
  return fallback;
}

function compactObservation(value: unknown) {
  const serialized = JSON.stringify(value);
  return !serialized || serialized.length <= MAX_PLANNER_OBSERVATION_CHARS
    ? value
    : { truncated: true, preview: serialized.slice(0, MAX_PLANNER_OBSERVATION_CHARS) };
}

/** 将工具参数规范化，避免同一读取请求反复消耗 Planner 的只读预算。 */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function toolActionSignature(action: PlannerToolAction) {
  return `${action.tool}:${stableSerialize(action.args)}`;
}

function isPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** 仅兼容模型将 read_file 动作压缩为 { filePath, startLine?, endLine? } 的固定形式。 */
function parseReadFileShorthand(value: Record<string, unknown>): PlannerToolAction | null {
  if (value.type !== undefined || value.tool !== undefined || value.args !== undefined || value.status !== undefined) return null;
  const allowedFields = new Set(["filePath", "startLine", "endLine"]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  if (typeof value.filePath !== "string" || !value.filePath.trim()) return null;
  if (value.startLine !== undefined && !isPositiveInteger(value.startLine)) return null;
  if (value.endLine !== undefined && !isPositiveInteger(value.endLine)) return null;
  return {
    type: "tool",
    tool: "read_file",
    args: Object.fromEntries(Object.entries(value).filter(([key]) => allowedFields.has(key)))
  };
}

function isMissingDirectoryObservation(action: PlannerToolAction, recovery: ReturnType<typeof recoverableToolObservation>) {
  return action.tool === "list_directory"
    && recovery
    && /directory not found|目录不存在/i.test(recovery.message);
}

function parseToolAction(value: unknown, availableTools: RuntimeToolDescriptor[]): PlannerToolAction | null {
  if (!isRecord(value)) return null;
  const shorthand = parseReadFileShorthand(value);
  if (shorthand) {
    if (!availableTools.some((item) => item.name === shorthand.tool && item.effect === "read")) {
      throw runtimeError("PERMISSION_DENIED", "Planner 无权调用工具 read_file。", { toolName: "read_file" });
    }
    return shorthand;
  }
  if (value.type !== "tool" && !(value.type === undefined && typeof value.tool === "string" && isRecord(value.args))) return null;
  // 部分兼容模型会遗漏固定的 type 字段；仅在工具名与参数结构都明确时兼容，避免误把 PlannerResult 当作工具动作。
  const tool = requiredString(value.tool, "Planner action.tool", 80);
  if (!PLANNER_READ_TOOL_NAMES.has(tool) || !availableTools.some((item) => item.name === tool && item.effect === "read")) {
    throw runtimeError("PERMISSION_DENIED", `Planner 无权调用工具 ${tool}。`, { toolName: tool });
  }
  if (!isRecord(value.args)) throw runtimeError("INVALID_CONTRACT", "Planner action.args 必须是对象。");
  return { type: "tool", tool, args: value.args };
}

function isPlannerRunContext(value: unknown): value is PlannerRunContext {
  return isRecord(value)
    && (value.phase === "create" || value.phase === "replan")
    && isRecord(value.request);
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
  // 模型预算耗尽由路由统一转为可恢复暂停，不能在 Planner 内降级成不可区分的计划失败。
  if (error instanceof AgentRuntimeError && error.code === "AGENT_MODEL_BUDGET_EXCEEDED") throw error;
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
export class PlannerAgent implements Agent {
  readonly id = "planner";
  readonly capabilities = ["planning", "exploration"];

  constructor(private readonly model: PlannerAgentDecisionModel = new ProviderPlannerAgentDecisionModel()) {}

  /** 供 Runtime 使用：Planner 只能在 Runtime 注入的只读工具白名单内补齐事实。 */
  async run(task: AgentTaskPacket, context: AgentContext): Promise<PlannerAgentResult> {
    if (task.writeScope.length) throw runtimeError("PERMISSION_DENIED", "Planner Task 不允许声明 writeScope。", { taskId: task.taskId });
    if (!isPlannerRunContext(task.context)) throw runtimeError("INVALID_CONTRACT", "Planner Task 缺少规划请求上下文。", { taskId: task.taskId });

    const request = task.context.request;
    const phase = task.context.phase;
    if (!this.model.nextAction) {
      const planning = phase === "create"
        ? await this.createPlan(request as PlannerCreatePlanInput)
        : await this.replan(request as PlannerReplanInput);
      return this.toRuntimeResult(task.taskId, planning);
    }

    const observations: Array<{ tool: string; result: unknown }> = [];
    let rejectedMissingContextCount = 0;
    let readToolCallCount = 0;
    let finalizationStepCount = 0;
    const executedToolActions = new Set<string>();
    while (finalizationStepCount < MAX_PLANNER_FINALIZATION_STEPS) {
      const actionValue = await this.model.nextAction(buildPlannerToolPrompt({
        phase,
        request,
        availableTools: context.availableTools.filter((tool) => PLANNER_READ_TOOL_NAMES.has(tool.name)),
        observations,
        readToolCallCount,
        maxReadToolCalls: MAX_PLANNER_READ_TOOL_CALLS,
        forceFinalization: readToolCallCount >= MAX_PLANNER_READ_TOOL_CALLS
      }), context.signal);
      const action = parseToolAction(actionValue, context.availableTools);
      if (!action) {
        let planning: PlannerResult;
        try {
          planning = phase === "create"
            ? parseResult(actionValue, (request as PlannerCreatePlanInput).goal, 1, request as PlannerCreatePlanInput)
            : parseResult(actionValue, (request as PlannerReplanInput).oldPlan.goal, (request as PlannerReplanInput).oldPlan.version + 1, request as PlannerReplanInput, false);
        } catch (error) {
          // 模型返回合法 JSON 但不是 PlannerResult 时，保留诊断并让有限的最终化轮次继续收敛。
          finalizationStepCount += 1;
          observations.push({
            tool: "planner_policy",
            result: {
              rejected: "invalid_planner_result",
              message: error instanceof Error ? error.message : "PlannerResult 格式无效",
              instruction: "请基于已有 observations 返回合法 PlannerResult；若证据不足，将未知细节写入 assumptions。"
            }
          });
          continue;
        }
        if (planning.status === "missing_context" && context.availableTools.some((tool) => PLANNER_READ_TOOL_NAMES.has(tool.name) && tool.effect === "read") && rejectedMissingContextCount < 2) {
          rejectedMissingContextCount += 1;
          // 缺少的信息仍可由已授权只读工具获得时，不把责任转交给用户；要求 Planner 继续调查。
          observations.push({
            tool: "planner_policy",
            result: {
              rejected: "missing_context",
              required: planning.required,
              instruction: "这些信息仍可通过 availableTools 在 readScope 内读取。请选择下一项只读工具并继续调查；不要再次返回 missing_context。"
            }
          });
          continue;
        }
        if (phase === "replan" && planning.status === "ready") preserveCompletedTasks(planning.plan, request as PlannerReplanInput);
        return this.toRuntimeResult(task.taskId, planning);
      }
      const actionSignature = toolActionSignature(action);
      if (executedToolActions.has(actionSignature)) {
        finalizationStepCount += 1;
        // 已有观察结果会持续传回模型，拒绝重复读取并让模型基于现有证据收敛。
        observations.push({
          tool: "planner_policy",
          result: {
            rejected: "duplicate_tool_action",
            action: { tool: action.tool, args: action.args },
            instruction: "该只读请求已经执行过，结果已在 observations 中。请选择未读取的相关文件，或直接根据现有证据返回 PlannerResult。"
          }
        });
        continue;
      }
      if (readToolCallCount >= MAX_PLANNER_READ_TOOL_CALLS) {
        finalizationStepCount += 1;
        observations.push({
          tool: "planner_policy",
          result: {
            rejected: "read_tool_budget_exhausted",
            instruction: "已达到只读工具调用上限。不得再调用工具；请基于 observations 中的证据立即返回 PlannerResult，未验证的细节写入 assumptions。"
          }
        });
        continue;
      }
      executedToolActions.add(actionSignature);
      readToolCallCount += 1;
      try {
        observations.push({ tool: action.tool, result: compactObservation(await context.callTool(action.tool, action.args)) });
      } catch (error) {
        const recovery = recoverableToolObservation(error);
        if (!recovery) throw error;
        // 目标目录尚未创建是实现类任务的正常前置状态，不应阻断 Planner。
        observations.push({
          tool: action.tool,
          result: isMissingDirectoryObservation(action, recovery)
            ? {
              ...recovery,
              missingDirectory: typeof action.args.path === "string" ? action.args.path : "",
              instruction: "该目录当前不存在；若计划涉及写入该目录，可在实现任务中先创建它。请继续调查或基于现有证据生成计划。"
            }
            : recovery
        });
      }
    }
    // 模型未遵守强制收敛提示时，使用保守计划继续后续流程；实际写入任务仍会自行读取和验证代码。
    return this.toRuntimeResult(task.taskId, createFallbackPlan(request, phase, observations));
  }

  private toRuntimeResult(taskId: string, planning: PlannerResult): PlannerAgentResult {
    const blockers = planning.status === "failed" ? planning.blockers : planning.status === "missing_context" ? planning.required : [];
    // 输出 Planner 决策结果的统一 debug 日志（任务数、阻断原因等核心摘要）。
    if (planning.status === "ready") {
      debugPlanner(`decision=ready taskId=${taskId} taskCount=${planning.plan.tasks.length} completionCriteriaCount=${planning.plan.completionCriteria.length}`, {
        version: planning.plan.version,
        goal: planning.plan.goal,
        assumptions: planning.plan.assumptions,
        tasks: planning.plan.tasks.map((task) => ({ id: task.id, type: task.type, goal: task.goal, dependencies: task.dependencies, acceptanceCriteriaCount: task.acceptanceCriteria.length }))
      });
    } else if (planning.status === "missing_context") {
      debugPlanner(`decision=missing_context taskId=${taskId} required=${JSON.stringify(planning.required)}`);
    } else {
      debugPlanner(`decision=failed taskId=${taskId} reason=${planning.reason} blockers=${JSON.stringify(planning.blockers)}`);
    }
    return {
      taskId,
      status: planning.status === "failed" ? "failed" : planning.status === "missing_context" ? "blocked" : "success",
      summary: planning.status === "ready" ? "Planner 已生成任务计划。" : planning.status === "missing_context" ? "Planner 仍需要仓库上下文。" : "Planner 未能生成有效计划。",
      facts: [],
      changedFiles: [],
      evidence: [],
      blockers,
      planning
    };
  }

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
        signal: input.signal,
        ...scope
      };
    } catch (error) {
      return failedResult(error, "input");
    }
    // 输出 createPlan 输入摘要，便于排查计划为何如此生成。
    debugPlanner("createPlan input", {
      goal: normalizedInput.goal,
      readScope: normalizedInput.readScope,
      writeScope: normalizedInput.writeScope,
      knownFactsCount: normalizedInput.knownFacts.length,
      constraintsCount: normalizedInput.constraints.length
    });
    try {
      return parseResult(await this.model.createPlan(buildCreatePlanPrompt(normalizedInput), normalizedInput.signal), normalizedInput.goal, 1, normalizedInput);
    } catch (error) {
      if (normalizedInput.signal?.aborted) throw runtimeError("AGENT_CANCELLED", "Planner 创建计划已取消。");
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
        signal: input.signal,
        ...scope
      };
    } catch (error) {
      return failedResult(error, "input");
    }
    // 输出 replan 输入摘要，便于排查重规划为何如此生成。
    debugPlanner("replan input", {
      oldPlanVersion: input.oldPlan.version,
      goal: input.oldPlan.goal,
      completedTasks: normalizedInput.completedTasks,
      readScope: normalizedInput.readScope,
      writeScope: normalizedInput.writeScope,
      newFactsCount: normalizedInput.newFacts.length,
      constraintsCount: normalizedInput.constraints.length
    });
    try {
      const result = parseResult(
        await this.model.replan(buildReplanPrompt(normalizedInput), normalizedInput.signal),
        input.oldPlan.goal,
        input.oldPlan.version + 1,
        normalizedInput,
        // 重规划允许模型省略已完成节点，最终 DAG 在可信节点恢复后统一校验。
        false
      );
      if (result.status === "ready") preserveCompletedTasks(result.plan, normalizedInput);
      return result;
    } catch (error) {
      if (normalizedInput.signal?.aborted) throw runtimeError("AGENT_CANCELLED", "Planner 重规划已取消。");
      return failedResult(error, "model");
    }
  }
}
