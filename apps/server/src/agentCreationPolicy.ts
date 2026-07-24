import type { AgentMode } from "./agentModes.js";
import type { AgentContext, CreateIntentFact, NegativeEvidence } from "./agentToolTypes.js";
import type { ModelToolCall } from "./contracts/index.js";

const SEARCH_TOOL_NAMES = new Set(["searchFilesByName", "searchCode", "searchCodeRegex"]);

export function normalizeSearchTarget(value: string) {
  return value
    .toLocaleLowerCase()
    .replace(/\bnew\b/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function isConcretePathTarget(evidence: NegativeEvidence) {
  const target = evidence.query.trim();
  return evidence.kind === "path_absent"
    && evidence.exhaustive
    && evidence.sourceTool === "searchFilesByName"
    && target.length >= 2
    && !/^[*.]+[a-z0-9]+$/i.test(target)
    && !/[*?[\]{}]/.test(target);
}

/**
 * 将 feature 任务中的完整路径未命中提升为创建事实。
 * 只在 Act 模式且工作区修改已授权时生效，避免只读分析误触发写入策略。
 */
export function promoteCreateIntentFacts(
  agentContext: AgentContext,
  options: { mode: AgentMode; workflowType: string; workspaceMutationAuthorized: boolean }
) {
  if (options.mode !== "act" || options.workflowType !== "feature" || !options.workspaceMutationAuthorized) return [];

  agentContext.createIntents ||= [];
  const added: CreateIntentFact[] = [];
  for (const evidence of agentContext.negativeEvidence || []) {
    if (!isConcretePathTarget(evidence)) continue;
    const duplicate = agentContext.createIntents.some(
      (intent) => intent.scope === evidence.scope
        && normalizeSearchTarget(intent.target) === normalizeSearchTarget(evidence.query)
    );
    if (duplicate) continue;

    const fact: CreateIntentFact = {
      target: evidence.query,
      scope: evidence.scope,
      sourceTool: evidence.sourceTool,
      reason: "exhaustive_target_absent",
      createdAt: Date.now()
    };
    agentContext.createIntents.push(fact);
    added.push(fact);
  }
  return added;
}

export function getSearchScope(toolCall: ModelToolCall) {
  const pathValue = String(toolCall.arguments.path || "").trim() || ".";
  const filePattern = String(toolCall.arguments.filePattern || "").trim();
  return filePattern ? `${pathValue} (glob: ${filePattern})` : pathValue;
}

function targetsSamePlannedCreation(query: string, target: string) {
  const normalizedQuery = normalizeSearchTarget(query);
  const normalizedTarget = normalizeSearchTarget(target);
  if (!normalizedQuery || !normalizedTarget) return false;
  return normalizedQuery === normalizedTarget
    || (Math.min(normalizedQuery.length, normalizedTarget.length) >= 4
      && (normalizedQuery.endsWith(normalizedTarget) || normalizedTarget.endsWith(normalizedQuery)));
}

/**
 * 已确认需要创建后，阻止模型在同一范围继续搜索同名或同职责目标。
 * 例如 router、VueRouter 和 new Router 会归入同一创建目标。
 */
export function getCreateIntentSearchBlockReason(toolCall: ModelToolCall, agentContext: AgentContext) {
  if (!SEARCH_TOOL_NAMES.has(toolCall.name)) return null;
  const query = String(toolCall.arguments.query || toolCall.arguments.regex || "").trim();
  const scope = getSearchScope(toolCall);
  const intent = (agentContext.createIntents || []).find(
    (item) => item.scope === scope && targetsSamePlannedCreation(query, item.target)
  );
  if (!intent) return null;

  return `已通过 exhaustive 搜索确认 ${intent.scope} 中不存在“${intent.target}”，并已形成创建意图。停止重复搜索同名或同职责目标，下一步请构建文件计划并调用 proposePatch 或 writeFile(createIfMissing=true)。`;
}
