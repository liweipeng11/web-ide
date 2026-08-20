import { config } from "./config.js";
import { createAiRunId, logAi } from "./aiHttp.js";
import { requestJsonChatCompletion } from "./modelGatewayClient.js";
import { getActiveModelId } from "./modelExecutionContext.js";
import { AI_TASK_PLAN_REWRITE_SYSTEM_PROMPT, AI_TASK_PLAN_SYSTEM_PROMPT } from "./prompts.js";
import { setTaskPlanItems, setTaskSessionRuntimePlanning, setTaskSessionWorkflow } from "./taskSessionStore.js";
import { createTaskWorkflow, getTaskWorkflowSteps, type TaskWorkflowSnapshot, type TaskWorkflowType } from "./taskWorkflow/index.js";
import type { AgentIntent, AgentRequestClassification } from "./aiClient.js";
import type { DeliveryUnit, TaskPlanItem, TaskPlanItemStatus, TaskSession } from "./types.js";
import { getRelevantProjectMemoryPrompt } from "./projectMemory/index.js";
import {
  MainAgentRuntime,
  type MainAgentExplorationPlanningResult,
  type MainAgentPlanningResult
} from "./agents/main/mainAgentRuntime.js";
import { createMainLoopPlan } from "./agents/main/orchestrationPlan.js";

type GeneratedPlanItem = {
  id?: string;
  workflowStepId?: string;
  title: string;
  status?: TaskPlanItemStatus;
  note?: string;
};

const validationWorkflowStepIds = new Set(["validate", "regression-validation", "regression"]);
const changeWorkflowStepIds = new Set(["implement", "minimal-fix", "refactor"]);

/**
 * 将计划项转换为 Runtime 可消费的最小交付边界。
 * 当前阶段严格按工作流顺序一项一单元；没有明确依赖证据时不虚构 DAG 或文件范围。
 */
export function buildDeliveryUnitsFromTaskPlan(
  planItems: TaskPlanItem[],
  workflow?: TaskWorkflowSnapshot,
  previousUnits: DeliveryUnit[] = [],
  now = Date.now()
): DeliveryUnit[] {
  const previousByPlanItemId = new Map(previousUnits.flatMap((unit) => unit.sourcePlanItemIds.map((id) => [id, unit] as const)));

  return planItems.map((item) => {
    const previous = previousByPlanItemId.get(item.id);
    const stepId = item.workflowStepId || "";
    const isValidation = validationWorkflowStepIds.has(stepId);
    const isChange = changeWorkflowStepIds.has(stepId);
    const completionCriteria = isValidation
      ? ["已记录对应验证命令的执行结果"]
      : isChange
        ? ["已生成可审查补丁或已应用文件变更"]
        : ["已形成结构化结论或明确阻塞项"];
    const candidateFiles = item.evidence?.files || [];
    const status = previous?.status
      || (item.status === "in_progress" ? "active" : "pending");

    return {
      version: 1 as const,
      // 复用已有单元 ID，确保计划重写后完成证据仍可追溯。
      id: previous?.id || `unit-${item.id}`,
      title: item.title,
      sourcePlanItemIds: [item.id],
      status,
      completionCriteria: previous?.completionCriteria.length ? previous.completionCriteria : completionCriteria,
      candidateFiles: previous?.candidateFiles.length ? previous.candidateFiles : candidateFiles,
      filesRead: previous?.filesRead.length ? previous.filesRead : candidateFiles,
      plannedFiles: previous?.plannedFiles.length ? previous.plannedFiles : [],
      // 仅消费已有计划/影响分析证据；工作流顺序本身不等于显式依赖关系。
      dependencyUnitIds: previous?.dependencyUnitIds || [],
      checkpointIds: previous?.checkpointIds || [],
      verificationCommands: previous?.verificationCommands || [],
      createdAt: previous?.createdAt || now,
      updatedAt: now
    };
  });
}

const explicitPlanPatterns = [/计划|步骤|todo|待办|plan|steps/i];
const complexGoalPatterns = [/修复|实现|新增|添加|重构|迁移|优化|升级|多文件|测试失败|构建失败|报错|错误|fix|implement|refactor|migrate|optimize|error|failed|failure/i];

function extractJsonContent(rawContent: string) {
  const trimmed = rawContent.trim();
  const fencedJson = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fencedJson?.[1]) {
    return fencedJson[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizePlanItems(items: unknown): GeneratedPlanItem[] {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      workflowStepId: typeof item.workflowStepId === "string" ? item.workflowStepId.trim().slice(0, 80) : undefined,
      title: typeof item.title === "string" ? item.title.trim().slice(0, 80) : "",
      status: isPlanStatus(item.status) ? item.status : undefined,
      note: typeof item.note === "string" ? item.note.trim().slice(0, 180) : undefined
    }))
    .filter((item) => item.title)
    .slice(0, 6);
}

function isPlanStatus(value: unknown): value is TaskPlanItemStatus {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "blocked";
}

// 判断任务是否足够复杂，只有复杂编辑才进入“先计划后执行”的审批流。
function isComplexTaskGoal(userGoal: string, intent: AgentIntent, options: { selectedPath?: string | null; contextFileCount?: number } = {}) {
  const normalizedGoal = userGoal.trim();
  const seemsComplex =
    normalizedGoal.length >= 80 ||
    complexGoalPatterns.some((pattern) => pattern.test(normalizedGoal)) ||
    (options.contextFileCount || 0) >= 2;

  if (intent === "diagnose_then_edit") {
    return true;
  }

  if (intent === "edit") {
    return seemsComplex;
  }

  if (intent === "inspect") {
    return seemsComplex;
  }

  return false;
}

function shouldRequirePlanApproval(classification?: AgentRequestClassification, options: { forceApproval?: boolean; selectedPath?: string | null; contextFileCount?: number } = {}) {
  if (options.forceApproval !== undefined) return options.forceApproval;
  const intent = classification?.intent || "edit";

  if (intent === "edit" || intent === "diagnose_then_edit") {
    return true;
  }

  const normalizedGoal = classification?.normalizedGoal || "";
  return isComplexTaskGoal(normalizedGoal, intent, options);
}

function getDefaultWorkflowType(intent: AgentIntent): TaskWorkflowType | null {
  if (intent === "diagnose_then_edit") return "bugfix";
  if (intent === "edit") return "feature";
  if (intent === "chat" || intent === "inspect") return "analysis-only";
  return null;
}

export function createFallbackTaskPlan(userGoal: string, intent: AgentIntent = "edit", workflowType: TaskWorkflowType | null = getDefaultWorkflowType(intent)): GeneratedPlanItem[] {
  const normalizedGoal = userGoal.trim();

  if (workflowType) {
    return getTaskWorkflowSteps(workflowType).map((step, index) => ({
      workflowStepId: step.id,
      title: step.title,
      note: index === 0 && normalizedGoal ? `目标：${normalizedGoal.slice(0, 80)}；${step.description}` : step.description
    }));
  }

  if (intent === "command") {
    return [
      { title: "确认要执行的命令" },
      { title: "评估命令风险" },
      { title: "执行命令并记录结果" }
    ];
  }

  return [
    { title: "理解需求目标", note: normalizedGoal ? `目标：${normalizedGoal.slice(0, 80)}` : undefined },
    { title: "检索并读取相关文件" },
    { title: "生成可审查修改" },
    { title: "应用修改并检查结果" },
    { title: "运行验证命令" }
  ];
}

// AI 只能补充各阶段说明，阶段 ID、标题和顺序始终以工作流模板为准。
export function alignTaskPlanToWorkflow(items: GeneratedPlanItem[], workflow: TaskWorkflowSnapshot, userGoal = ""): GeneratedPlanItem[] {
  const normalizedGoal = userGoal.trim();

  return workflow.steps.map((step, index) => {
    const candidate = items[index];
    const fallbackNote = index === 0 && normalizedGoal ? `目标：${normalizedGoal.slice(0, 80)}；${step.description}` : step.description;

    return {
      workflowStepId: step.id,
      title: step.title,
      note: candidate?.note?.trim() || fallbackNote
    };
  });
}

// 只接受当前计划已有的步骤 ID，并通过标题或剩余一一对应关系恢复模型遗漏的 ID。
export function reconcileRewrittenTaskPlanWorkflowIds(currentItems: TaskPlanItem[], rewrittenItems: GeneratedPlanItem[]): GeneratedPlanItem[] {
  const validIds = new Set(currentItems.map((item) => item.workflowStepId).filter((value): value is string => Boolean(value)));
  const usedIds = new Set<string>();
  const reconciled = rewrittenItems.map((item) => {
    const requestedId = item.workflowStepId && validIds.has(item.workflowStepId) && !usedIds.has(item.workflowStepId) ? item.workflowStepId : undefined;
    const titleMatchedId = currentItems.find((current) => current.title === item.title && current.workflowStepId && !usedIds.has(current.workflowStepId))?.workflowStepId;
    const workflowStepId = requestedId || titleMatchedId;

    if (workflowStepId) usedIds.add(workflowStepId);
    return { ...item, workflowStepId, id: workflowStepId ? currentItems.find((current) => current.workflowStepId === workflowStepId)?.id : undefined };
  });
  const unresolvedIndexes = reconciled.flatMap((item, index) => item.workflowStepId ? [] : [index]);
  const remainingIds = currentItems.map((item) => item.workflowStepId).filter((value): value is string => typeof value === "string" && !usedIds.has(value));

  // 数量一一对应时可安全恢复重命名步骤；删除或新增导致数量变化时不猜测语义。
  if (unresolvedIndexes.length === remainingIds.length) {
    unresolvedIndexes.forEach((itemIndex, index) => {
      reconciled[itemIndex] = { ...reconciled[itemIndex], workflowStepId: remainingIds[index] };
      reconciled[itemIndex].id = currentItems.find((current) => current.workflowStepId === remainingIds[index])?.id;
    });
  }

  return reconciled;
}

export function shouldInitializeTaskPlan(userGoal: string, classification?: AgentRequestClassification, options: { force?: boolean; selectedPath?: string | null; contextFileCount?: number } = {}) {
  const normalizedGoal = userGoal.trim();
  const intent = classification?.intent || "edit";

  if (options.force || explicitPlanPatterns.some((pattern) => pattern.test(normalizedGoal))) {
    return true;
  }

  if (intent === "edit" || intent === "diagnose_then_edit") {
    return true;
  }

  if (intent === "command") {
    return false;
  }

  // inspect 任务也需要显式进入 analysis-only 流程，确保计划中不会混入编辑步骤。
  return intent === "inspect";
}

export async function generateTaskPlan(userGoal: string, classification?: AgentRequestClassification, workflow?: TaskWorkflowSnapshot): Promise<GeneratedPlanItem[]> {
  const fallback = createFallbackTaskPlan(userGoal, classification?.intent || "edit", workflow?.type);

  if (!config.aiApiKey) {
    return fallback;
  }

  const runId = createAiRunId("task-plan");

  try {
    const projectMemoryPrompt = await getRelevantProjectMemoryPrompt({ userRequest: userGoal });
    const data = await requestJsonChatCompletion({
      model: getActiveModelId(config.aiModel),
      temperature: 0,
      messages: [
        { role: "system", content: [AI_TASK_PLAN_SYSTEM_PROMPT, projectMemoryPrompt].filter(Boolean).join("\n\n") },
        {
          role: "user",
          content: JSON.stringify(
            {
              userGoal,
              intent: classification?.intent || "edit",
              normalizedGoal: classification?.normalizedGoal || userGoal,
              reason: classification?.reason || "",
              workflow: workflow
                ? {
                    type: workflow.type,
                    reason: workflow.reason,
                    requiredSteps: workflow.steps.map((step) => ({ title: step.title, description: step.description }))
                  }
                : undefined
            },
            null,
            2
          )
        }
      ]
    });
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = rawContent ? (JSON.parse(extractJsonContent(rawContent)) as { items?: unknown }) : null;
    const items = normalizePlanItems(parsed?.items);

    if (items.length) {
      const alignedItems = workflow ? alignTaskPlanToWorkflow(items, workflow, userGoal) : items;
      logAi(runId, "done", { count: alignedItems.length, workflow: workflow?.type || null });
      return alignedItems;
    }
  } catch (error) {
    logAi(runId, "fallback", { error: error instanceof Error ? error.message : String(error) });
  }

  return fallback;
}

type RuntimePlanningFacade = Pick<MainAgentRuntime, "plan"> & Partial<Pick<MainAgentRuntime, "planWithExploration">>;

export async function initializeTaskPlan(session: TaskSession, classification?: AgentRequestClassification, options: { force?: boolean; forceApproval?: boolean; selectedPath?: string | null; contextFileCount?: number; runtimePlanning?: boolean; runtimePlanner?: RuntimePlanningFacade } = {}) {
  // 纯命令请求不属于四类代码任务工作流，保持原有命令执行链路。
  if (classification?.intent === "command") {
    return session;
  }

  const workflow = createTaskWorkflow(classification?.normalizedGoal || session.userGoal, classification);
  let workflowSession = (await setTaskSessionWorkflow(session.id, workflow)) || session;

  if (!shouldInitializeTaskPlan(classification?.normalizedGoal || session.userGoal, classification, options)) {
    return workflowSession;
  }

  if (options.runtimePlanning) {
    const runtimePlanner = options.runtimePlanner ?? new MainAgentRuntime();
    const request = {
      goal: classification?.normalizedGoal || session.userGoal,
      // TaskSession ID 在重试和服务重启后保持不变，确保只读 Graph 灰度路径稳定。
      rolloutKey: session.id,
      knownFacts: workflowSession.filesRead.map((filePath) => `已读取文件：${filePath}`),
      constraints: classification?.reason ? [classification.reason] : [],
      acceptanceCriteria: [`完成并验证用户目标：${classification?.normalizedGoal || session.userGoal}`],
      // Planner 只声明后续任务边界，不直接获得这些路径对应的工具权限。
      readScope: ["**"],
      writeScope: classification?.intent === "inspect" ? [] : options.selectedPath ? [options.selectedPath] : ["**"],
      testScope: ["**/*.test.*", "**/*.spec.*", "**/tests/**", "**/__tests__/**"]
    };
    // 阶段 3：生产入口优先允许 Main 用 Explorer 补齐缺失事实；测试或旧适配器仍可只实现 plan。
    const planningResult: MainAgentPlanningResult | MainAgentExplorationPlanningResult = runtimePlanner.planWithExploration
      ? await runtimePlanner.planWithExploration(request)
      : await runtimePlanner.plan(request);
    if (planningResult.planning) {
      const createdAt = Date.now();
      const explorations = (planningResult as Partial<MainAgentExplorationPlanningResult>).explorations ?? [];
      const explorerArtifacts = explorations.flatMap((execution) =>
        execution.exploration
          ? [{ taskId: execution.result.taskId, result: execution.exploration, createdAt }]
          : []
      );
      workflowSession = (await setTaskSessionRuntimePlanning(session.id, planningResult.planning, explorerArtifacts)) || workflowSession;
      if (planningResult.planning.status !== "ready") return workflowSession;
    } else if (planningResult.decision.route === "main_loop" && planningResult.decision.intent === "code_change") {
      // 中等修改跳过 Planner，但仍建立受 Runtime 校验的 implement → test DAG。
      const plan = createMainLoopPlan(request);
      workflowSession = (await setTaskSessionRuntimePlanning(session.id, { status: "ready", plan })) || workflowSession;
    }
  }

  const items = await generateTaskPlan(classification?.normalizedGoal || session.userGoal, classification, workflow);

  // 新任务创建后立即写入计划，第一步默认进入“进行中”。
  return setTaskPlanItems(session.id, items, {
    requireApproval: shouldRequirePlanApproval(classification, options),
    deliveryUnitFactory: (planItems, previousUnits, now) => buildDeliveryUnitsFromTaskPlan(planItems, workflow, previousUnits, now)
  });
}

function rewritePlanFallback(items: TaskPlanItem[], instruction: string): GeneratedPlanItem[] {
  const normalized = instruction.trim();
  const nextItems = items.map((item) => ({
    id: item.id,
    workflowStepId: item.workflowStepId,
    title: item.title,
    status: item.status,
    note: item.note
  }));
  const deleteMatch = normalized.match(/(?:删除|移除|去掉|delete|remove)\D*(\d+)/i);
  const moveFirstMatch = normalized.match(/(?:提前|置顶|先做|优先|move.*first)\D*(\d+)/i);

  if (deleteMatch?.[1]) {
    const index = Number(deleteMatch[1]) - 1;
    return nextItems.filter((_item, itemIndex) => itemIndex !== index);
  }

  if (moveFirstMatch?.[1]) {
    const index = Number(moveFirstMatch[1]) - 1;
    const target = nextItems[index];

    if (target) {
      return [target, ...nextItems.filter((_item, itemIndex) => itemIndex !== index)];
    }
  }

  return [...nextItems, { title: normalized.slice(0, 80), status: "pending" }];
}

export async function rewriteTaskPlanWithInstruction(session: TaskSession, instruction: string) {
  const currentItems = session.planItems || [];
  const fallback = rewritePlanFallback(currentItems, instruction);

  if (!config.aiApiKey) {
    return persistRewrittenTaskPlan(session, fallback, instruction);
  }

  const runId = createAiRunId("task-plan-rewrite");

  try {
    const projectMemoryPrompt = await getRelevantProjectMemoryPrompt({
      userRequest: `${session.userGoal}\n${instruction}`,
      contextPaths: session.filesRead,
      plannedFiles: session.filesChanged
    });
    const data = await requestJsonChatCompletion({
      model: getActiveModelId(config.aiModel),
      temperature: 0,
      messages: [
        { role: "system", content: [AI_TASK_PLAN_REWRITE_SYSTEM_PROMPT, projectMemoryPrompt].filter(Boolean).join("\n\n") },
        {
          role: "user",
          content: JSON.stringify(
            {
              userGoal: session.userGoal,
              instruction,
              currentItems: currentItems.map((item) => ({
                workflowStepId: item.workflowStepId,
                title: item.title,
                status: item.status,
                note: item.note
              }))
            },
            null,
            2
          )
        }
      ]
    });
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = rawContent ? (JSON.parse(extractJsonContent(rawContent)) as { items?: unknown }) : null;
    const items = normalizePlanItems(parsed?.items);

    if (items.length) {
      const reconciledItems = reconcileRewrittenTaskPlanWorkflowIds(currentItems, items);
      logAi(runId, "done", { count: reconciledItems.length });
      return persistRewrittenTaskPlan(session, reconciledItems, instruction);
    }
  } catch (error) {
    logAi(runId, "fallback", { error: error instanceof Error ? error.message : String(error) });
  }

  return persistRewrittenTaskPlan(session, fallback, instruction);
}

// 用户与验证触发的计划修订均通过同一原子写入路径同步交付单元。
function persistRewrittenTaskPlan(session: TaskSession, items: GeneratedPlanItem[], instruction: string) {
  return setTaskPlanItems(session.id, items, {
    requireApproval: session.planApproval?.status === "pending",
    revision: { trigger: "user", reason: instruction.trim() },
    deliveryUnitFactory: (planItems, previousUnits, now) => buildDeliveryUnitsFromTaskPlan(planItems, session.workflow, previousUnits, now)
  });
}
