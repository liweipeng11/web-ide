import { config } from "./config.js";
import { createAiRunId, logAi, requestJsonChatCompletion } from "./aiHttp.js";
import { AI_TASK_PLAN_REWRITE_SYSTEM_PROMPT, AI_TASK_PLAN_SYSTEM_PROMPT } from "./prompts.js";
import { setTaskPlanItems } from "./taskSessionStore.js";
import type { AgentIntent, AgentRequestClassification } from "./aiClient.js";
import type { TaskPlanItem, TaskPlanItemStatus, TaskSession } from "./types.js";

type GeneratedPlanItem = {
  title: string;
  status?: TaskPlanItemStatus;
  note?: string;
};

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
  const normalizedGoal = classification?.normalizedGoal || "";
  return isComplexTaskGoal(normalizedGoal, intent, options);
}

export function createFallbackTaskPlan(userGoal: string, intent: AgentIntent = "edit"): GeneratedPlanItem[] {
  const normalizedGoal = userGoal.trim();

  if (intent === "chat" || intent === "inspect") {
    return [
      { title: "理解问题和上下文" },
      { title: "检索相关代码和资料" },
      { title: "整理结论和建议" }
    ];
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

export function shouldInitializeTaskPlan(userGoal: string, classification?: AgentRequestClassification, options: { force?: boolean; selectedPath?: string | null; contextFileCount?: number } = {}) {
  const normalizedGoal = userGoal.trim();
  const intent = classification?.intent || "edit";

  if (options.force || explicitPlanPatterns.some((pattern) => pattern.test(normalizedGoal))) {
    return true;
  }

  if (intent === "edit" || intent === "diagnose_then_edit") {
    return isComplexTaskGoal(normalizedGoal, intent, options);
  }

  if (intent === "command") {
    return false;
  }

  return intent === "inspect" ? isComplexTaskGoal(normalizedGoal, intent, options) : false;
}

export async function generateTaskPlan(userGoal: string, classification?: AgentRequestClassification): Promise<GeneratedPlanItem[]> {
  const fallback = createFallbackTaskPlan(userGoal, classification?.intent || "edit");

  if (!config.aiApiKey) {
    return fallback;
  }

  const runId = createAiRunId("task-plan");

  try {
    const data = await requestJsonChatCompletion({
      model: config.aiModel,
      temperature: 0,
      messages: [
        { role: "system", content: AI_TASK_PLAN_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              userGoal,
              intent: classification?.intent || "edit",
              normalizedGoal: classification?.normalizedGoal || userGoal,
              reason: classification?.reason || ""
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
      logAi(runId, "done", { count: items.length });
      return items;
    }
  } catch (error) {
    logAi(runId, "fallback", { error: error instanceof Error ? error.message : String(error) });
  }

  return fallback;
}

export async function initializeTaskPlan(session: TaskSession, classification?: AgentRequestClassification, options: { force?: boolean; forceApproval?: boolean; selectedPath?: string | null; contextFileCount?: number } = {}) {
  if (!shouldInitializeTaskPlan(classification?.normalizedGoal || session.userGoal, classification, options)) {
    return null;
  }

  const items = await generateTaskPlan(classification?.normalizedGoal || session.userGoal, classification);

  // 新任务创建后立即写入计划，第一步默认进入“进行中”。
  return setTaskPlanItems(session.id, items, { requireApproval: shouldRequirePlanApproval(classification, options) });
}

function rewritePlanFallback(items: TaskPlanItem[], instruction: string): GeneratedPlanItem[] {
  const normalized = instruction.trim();
  const nextItems = items.map((item) => ({
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
    return setTaskPlanItems(session.id, fallback, { requireApproval: session.planApproval?.status === "pending", revision: { trigger: "user", reason: instruction.trim() } });
  }

  const runId = createAiRunId("task-plan-rewrite");

  try {
    const data = await requestJsonChatCompletion({
      model: config.aiModel,
      temperature: 0,
      messages: [
        { role: "system", content: AI_TASK_PLAN_REWRITE_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              userGoal: session.userGoal,
              instruction,
              currentItems: currentItems.map((item) => ({
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
      logAi(runId, "done", { count: items.length });
      return setTaskPlanItems(session.id, items, { requireApproval: session.planApproval?.status === "pending", revision: { trigger: "user", reason: instruction.trim() } });
    }
  } catch (error) {
    logAi(runId, "fallback", { error: error instanceof Error ? error.message : String(error) });
  }

  return setTaskPlanItems(session.id, fallback, { requireApproval: session.planApproval?.status === "pending", revision: { trigger: "user", reason: instruction.trim() } });
}
