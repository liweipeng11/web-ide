import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { createAiRunId, logAi } from "./aiHttp.js";
import {
  requestChatCompletion,
  requestChatCompletionStream,
  requestChatCompletionWithToolChoiceFallback,
  requestJsonChatCompletion,
  requestJsonChatCompletionWithToolChoiceFallback
} from "./modelGatewayClient.js";
import { buildUserPrompt, AI_AGENT_INTENT_SYSTEM_PROMPT, AI_FILE_CHAT_SYSTEM_PROMPT, AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, AI_SEARCH_KEYWORDS_SYSTEM_PROMPT, AI_SYSTEM_PROMPT } from "./prompts.js";
import { discoverProjectCommands } from "./commandDiscovery.js";
import { formatCommandFailureForPrompt, getLastFailedCommandResultForChat } from "./commandResults.js";
import { searchWorkspaceCode } from "./codeSearch.js";
import { buildEditScope } from "./editScope.js";
import { buildSafeEditRecommendation, type StructuredModificationPlan } from "./safeEditor/index.js";
import { readWorkspaceFile } from "./fileTools.js";
import { inspectCurrentProject } from "./projectInspector.js";
import { discoverProjectRules } from "./projectRules.js";
import type { AgentStep, AiEditResult, ChatContextFile, FileChatMessage, FilePatch } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { agentToolSchemas, createAgentToolRuntime, executeAgentToolCall, type AgentContext, type AgentToolCall } from "./agentTools.js";
import { createAgentStep } from "./routeAgentSteps.js";
import { getRelevantProjectMemoryPrompt } from "./projectMemory/index.js";
import { getActiveModelId } from "./modelExecutionContext.js";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
};

type FileChatToolLoopResult =
  | {
      finalContent: string;
      messages: ChatMessage[];
    }
  | {
      finalContent: null;
      messages: ChatMessage[];
    };

export type { AgentContext } from "./agentTools.js";
export type { AgentStep } from "./types.js";

export type EditPathRetryContext = {
  invalidFilePaths: string[];
  validFilePaths: string[];
  reason?: "invalid_paths" | "no_file_changes" | "scope_violation" | "stale_full_rewrite";
  previousSummary?: string;
};

const MAX_AUTO_READ_FILES = 5;
const MAX_READ_FILE_LINES = 240;
const MAX_READ_FILE_CHARS = 20_000;
const AI_LOG_PREVIEW_CHARS = 500;
const AI_FETCH_ATTEMPTS_PER_URL = 2;
const MAX_PREFLIGHT_EDIT_SEARCH_QUERIES = 4;
const MAX_PREFLIGHT_EDIT_SEARCH_RESULTS = 30;
const MAX_AUTO_EDIT_CONTEXT_FILES = MAX_AUTO_READ_FILES;
const MAX_PLAN_EDIT_SEARCH_QUERIES = 6;

const MAX_FILE_CHAT_TOOL_STEPS = 8;
const MAX_NULL_PATCH_RECOVERY_ATTEMPTS = 3;

export type AgentIntent = "chat" | "inspect" | "edit" | "diagnose_then_edit" | "command";

export type AgentRequestClassification = {
  intent: AgentIntent;
  confidence: number;
  normalizedGoal: string;
  reason: string;
};

const explicitEditPatterns = [
  /(?:\u8bf7|\u5e2e\u6211|\u76f4\u63a5|\u73b0\u5728)?(?:\u4fee\u6539|\u6539\u4e00\u4e0b|\u6539\u6210|\u4fee\u590d|\u5b9e\u73b0|\u65b0\u589e|\u6dfb\u52a0|\u5220\u9664|\u79fb\u9664|\u91cd\u6784|\u91cd\u547d\u540d|\u66ff\u6362|\u521b\u5efa|\u751f\u6210|\u914d\u7f6e|\u5347\u7ea7|\u8fc1\u79fb|\u4f18\u5316)(?:\u4ee3\u7801|\u6587\u4ef6|\u9879\u76ee|\u529f\u80fd|\u9875\u9762|\u7ec4\u4ef6|\u63a5\u53e3|\u6837\u5f0f|\u903b\u8f91)?/,
  /\b(?:fix|implement|add|remove|delete|rename|refactor|change|update|create|replace|configure|upgrade|migrate)\b/
];

const explicitReadOnlyPatterns = [
  /只(?:分析|检查|排查|说明|解释|给出方案)|仅(?:分析|检查|排查|说明|解释)|不要(?:修改|改动|编辑)|无需(?:修改|改动)|先(?:分析|检查|排查)(?:即可|就行)$|(?:分析|检查|排查|说明|解释)(?![^\n]{0,20}(?:修改|改动|编辑|修复|实现)).{0,20}(?:即可|就行)/i,
  /\b(?:analysis only|read[- ]only|do not (?:edit|modify|change)|without (?:editing|modifying|changing))\b/i
];

function hasExplicitReadOnlyConstraint(userRequest: string) {
  return explicitReadOnlyPatterns.some((pattern) => pattern.test(userRequest.trim()));
}

function isCommandExecutionRequest(userRequest: string) {
  const normalized = userRequest.trim().toLowerCase();
  const commandPatterns = [
    /(?:\u8fd0\u884c|\u542f\u52a8|\u8dd1\u8d77\u6765|\u6253\u5f00|\u9884\u89c8|\u6784\u5efa|\u6d4b\u8bd5|\u68c0\u67e5|\u6267\u884c)(?:\u8fd9\u4e2a|\u4e00\u4e0b|\u9879\u76ee|\u5e94\u7528|\u670d\u52a1|\u547d\u4ee4)?/,
    /\b(?:run|start|serve|preview|build|test|lint|check|open)\b/
  ];

  return commandPatterns.some((pattern) => pattern.test(normalized));
}

function isDiagnosticRequest(userRequest: string) {
  const normalized = userRequest.trim().toLowerCase();
  return /(?:\u8b66\u544a|\u62a5\u9519|\u9519\u8bef|\u5f02\u5e38|\u5931\u8d25|\u4e0d\u751f\u6548|\u65e0\u6cd5|\u4e0d\u80fd|warning|error|failed|failure|exception|not found)/i.test(normalized);
}

function hasExplicitEditRequest(userRequest: string) {
  const normalized = userRequest.trim().toLowerCase();
  return explicitEditPatterns.some((pattern) => pattern.test(normalized));
}

export function inferAgentRequestClassification(userRequest: string): AgentRequestClassification {
  const hasReadOnlyConstraint = hasExplicitReadOnlyConstraint(userRequest);
  const hasEditIntent = hasExplicitEditRequest(userRequest);
  const hasCommandIntent = isCommandExecutionRequest(userRequest);
  const hasDiagnosticIntent = isDiagnosticRequest(userRequest);
  let intent: AgentIntent = "chat";

  if (hasReadOnlyConstraint) {
    intent = hasDiagnosticIntent || hasEditIntent ? "inspect" : "chat";
  } else if (hasEditIntent && hasDiagnosticIntent) {
    intent = "diagnose_then_edit";
  } else if (hasEditIntent) {
    intent = "edit";
  } else if (hasCommandIntent) {
    intent = "command";
  } else if (hasDiagnosticIntent) {
    intent = "inspect";
  }

  return {
    intent,
    confidence: hasReadOnlyConstraint ? 0.95 : intent === "chat" ? 0.55 : 0.7,
    normalizedGoal: userRequest.trim(),
    reason: hasReadOnlyConstraint ? "Local heuristic fallback; explicit read-only constraint preserved" : "Local heuristic fallback"
  };
}

function isAgentIntent(value: unknown): value is AgentIntent {
  return value === "chat" || value === "inspect" || value === "edit" || value === "diagnose_then_edit" || value === "command";
}

function normalizeConfidence(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}

function protectExplicitEditIntent(userRequest: string, classification: AgentRequestClassification): AgentRequestClassification {
  if (hasExplicitReadOnlyConstraint(userRequest)) {
    return {
      ...classification,
      intent: isDiagnosticRequest(userRequest) || hasExplicitEditRequest(userRequest) ? "inspect" : "chat",
      confidence: Math.max(classification.confidence, 0.95),
      reason: `${classification.reason || "Model route"}; explicit read-only constraint preserved`
    };
  }

  if (!hasExplicitEditRequest(userRequest)) {
    return classification;
  }

  if (classification.intent === "command" || classification.intent === "chat") {
    return {
      ...classification,
      intent: isDiagnosticRequest(userRequest) ? "diagnose_then_edit" : "edit",
      reason: `${classification.reason || "Model route"}; explicit edit wording preserved`
    };
  }

  return classification;
}

export function shouldGeneratePatchForIntent(intent: AgentIntent) {
  return intent === "edit" || intent === "diagnose_then_edit";
}

// 专用编辑入口已经获得修改授权；当通用分类器过于保守时，只提升为普通编辑，不覆盖诊断修复意图。
export function ensureEditableAgentRequestClassification(classification: AgentRequestClassification): AgentRequestClassification {
  if (shouldGeneratePatchForIntent(classification.intent)) return classification;

  return {
    ...classification,
    intent: "edit",
    reason: `${classification.reason || "Request classification"}; direct edit endpoint requires an editable workflow`
  };
}

export async function classifyAgentRequest(history: FileChatMessage[], userRequest: string): Promise<AgentRequestClassification> {
  const inferred = inferAgentRequestClassification(userRequest);

  if (!config.aiApiKey) {
    return inferred;
  }

  const runId = createAiRunId("intent");

  try {
    const data = await requestJsonChatCompletion({
      model: getActiveModelId(config.aiModel),
      temperature: 0,
      messages: [
        { role: "system", content: AI_AGENT_INTENT_SYSTEM_PROMPT },
        ...history.slice(-6).map((message) => ({ role: message.role, content: message.content })),
        { role: "user", content: userRequest }
      ]
    });
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = rawContent ? (JSON.parse(extractJsonContent(rawContent)) as { intent?: unknown; confidence?: unknown; normalizedGoal?: unknown; reason?: unknown }) : null;

    if (isAgentIntent(parsed?.intent)) {
      const classification = protectExplicitEditIntent(userRequest, {
        intent: parsed.intent,
        confidence: normalizeConfidence(parsed.confidence, inferred.confidence),
        normalizedGoal: typeof parsed.normalizedGoal === "string" && parsed.normalizedGoal.trim() ? parsed.normalizedGoal.trim() : inferred.normalizedGoal,
        reason: typeof parsed.reason === "string" ? parsed.reason : ""
      });

      logAi(runId, "done", classification);
      return classification;
    }
  } catch (error) {
    logAi(runId, "fallback", { error: error instanceof Error ? error.message : String(error) });
  }

  return inferred;
}

export async function classifyAgentIntent(history: FileChatMessage[], userRequest: string): Promise<AgentIntent> {
  return (await classifyAgentRequest(history, userRequest)).intent;
}

function latestMessageContent(history: FileChatMessage[], role: FileChatMessage["role"]) {
  return [...history].reverse().find((message) => message.role === role && message.content.trim())?.content.trim() || "";
}

function hasPriorEditableContext(previousUserRequest: string, previousAssistantAnswer: string) {
  const previousContext = `${previousUserRequest}\n${previousAssistantAnswer}`.toLowerCase();

  return explicitEditPatterns.some((pattern) => pattern.test(previousContext)) || isDiagnosticRequest(previousContext) || /(?:patch|diff|修改|修复|文件|组件|接口|样式|warning|error|failed)/i.test(previousContext);
}

function isBriefContinuationCandidate(userRequest: string) {
  const normalized = userRequest.trim().toLowerCase();

  if (!normalized || normalized.length > 36) {
    return false;
  }

  return /^(?:请)?(?:继续|继续处理|继续修复|修复|处理|执行|应用|确认|可以|就这样|照做|按(?:你|上面|这个|刚才|前面).*(?:改|做|处理|修复)|照(?:你|上面|这个|刚才|前面).*(?:改|做|处理|修复)|do it|fix it|continue|apply(?: it| this)?|go ahead)$/i.test(normalized);
}

function hasNewStandaloneEditTarget(userRequest: string) {
  const normalized = userRequest.trim();

  // 短跟进如果带了明确文件、路径或带引号的新文案，更可能是新的独立需求。
  return /(?:[\w-]+\.(?:ts|tsx|js|jsx|vue|css|scss|html|json|md)|\/|\\|["""'''][^"""''']{2,}["""'''])/.test(normalized);
}

function shouldContinueEditFromContext(history: FileChatMessage[], userRequest: string, normalizedGoal?: string) {
  const currentRequest = userRequest.trim();
  const previousUserRequest = latestMessageContent(history, "user");
  const previousAssistantAnswer = latestMessageContent(history, "assistant");

  if (!previousUserRequest && !previousAssistantAnswer) {
    return false;
  }

  if (!hasPriorEditableContext(previousUserRequest, previousAssistantAnswer)) {
    return false;
  }

  if (normalizedGoal?.trim() && normalizedGoal.trim() !== currentRequest && currentRequest.length <= 60) {
    return true;
  }

  if (hasNewStandaloneEditTarget(currentRequest)) {
    return false;
  }

  return isBriefContinuationCandidate(currentRequest);
}

export function buildContextualEditRequest(history: FileChatMessage[], userRequest: string, normalizedGoal?: string) {
  const currentRequest = userRequest.trim();
  const normalized = normalizedGoal?.trim();

  if (!shouldContinueEditFromContext(history, currentRequest, normalized)) {
    return normalized || currentRequest;
  }

  const previousUserRequest = latestMessageContent(history, "user");
  const previousAssistantAnswer = latestMessageContent(history, "assistant");

  if (!previousUserRequest && !previousAssistantAnswer) {
    return currentRequest;
  }

  return [
    "The user is confirming a follow-up edit request based on the previous conversation.",
    "",
    "Current user request:",
    currentRequest,
    "",
    normalized ? "Normalized edit goal from intent router:" : "",
    normalized || "",
    "",
    previousUserRequest ? "Previous user problem/request:" : "",
    previousUserRequest,
    "",
    previousAssistantAnswer ? "Previous assistant analysis or proposed fix:" : "",
    previousAssistantAnswer,
    "",
    "Generate the actual code patch for the previous problem. Do not treat the current short follow-up as an isolated request."
  ]
    .filter((line) => line !== "")
    .join("\n");
}

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

async function getAvailableCommandsForPrompt() {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    return [];
  }

  return discoverProjectCommands(workspaceRoot);
}

async function getProjectFactsForPrompt() {
  return inspectCurrentProject().catch(() => null);
}

async function getProjectRulesForPrompt(contextPaths: string[] = []) {
  return discoverProjectRules(contextPaths)
    .then((snapshot) => ({
      activeRulePaths: snapshot.rules.filter((rule) => rule.active).map((rule) => `${rule.scope}:${rule.path}`),
      instructions: snapshot.combinedInstructions
    }))
    .catch(() => null);
}

function uniquePush(target: string[], value: string) {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function normalizeSearchKeyword(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

// 提取用户显式提到的按钮、文案或引号文本，避免搜索关键词只剩英文技术词。
function extractQuotedSearchKeywords(source: string) {
  const keywords: string[] = [];
  const addKeyword = (keyword: string) => {
    const normalized = normalizeSearchKeyword(keyword.replace(/^(?:把|将|给|把它|请把)\s*/u, "").replace(/\s*(?:改成|改为|换成|设为|做成|显示为).*$/u, ""));

    if (normalized && !keywords.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      keywords.push(normalized);
    }
  };

  for (const match of source.matchAll(/["“”'‘’]([^"“”'‘’]{2,40})["“”'‘’]/g)) {
    addKeyword(match[1]);
  }

  // 仅保留控件名前缀，避免把“把新增工具按钮改成二级样式”整段都当成搜索词。
  for (const match of source.matchAll(/(?:^|[\s，。、“”'"：（【])([\u4e00-\u9fa5A-Za-z0-9 _-]{2,24}?)(?:按钮|文案|标题|菜单|文本)/g)) {
    addKeyword(match[1]);
  }

  return keywords;
}

export function isIntermediateEditPlanSummary(summary: string) {
  const normalized = summary.trim();

  if (!normalized) {
    return false;
  }

  const hasPlanningLanguage = [
    /(?:\u5148|\u9996\u5148|\u63a5\u4e0b\u6765|\u4e0b\u4e00\u6b65|\u7136\u540e|\u518d|\u7ee7\u7eed|\u540e\u7eed)/,
    /\b(?:first|next|then|continue|after that)\b/i
  ].some((pattern) => pattern.test(normalized));
  const hasActionLanguage = [
    /(?:\u641c\u7d22|\u67e5\u627e|\u67e5\u770b|\u8bfb\u53d6|\u5206\u6790|\u521b\u5efa|\u65b0\u589e|\u4fee\u6539|\u96c6\u6210|\u751f\u6210|\u5b9e\u73b0|\u5f15\u5165|\u6ce8\u518c)/,
    /\b(?:search|inspect|read|analy[sz]e|create|add|modify|integrate|implement|generate|import|register)\b/i
  ].some((pattern) => pattern.test(normalized));
  const hasContextRequestLanguage = [
    // 兼容 Cline 式"先读上下文再编辑"的中间回复，避免把只缺上下文误判成最终失败。
    /(?:\u9700\u8981|\u9700|\u8fd8\u9700|\u5148)?(?:\u8bfb\u53d6|\u67e5\u770b|\u67e5\u627e|\u641c\u7d22|\u4e86\u89e3|\u786e\u8ba4|\u68c0\u67e5).*(?:\u6587\u4ef6|\u4e0a\u4e0b\u6587|\u7ed3\u6784|\u6a21\u5f0f|\u6570\u636e\u5c42|mock|api|store|view|route|router|component)/i,
    /\b(?:need|needs|required|requires|must)\b.*\b(?:read|inspect|search|check|understand)\b.*\b(?:file|context|structure|pattern|mock|api|store|view|route|router|component)\b/i
  ].some((pattern) => pattern.test(normalized));

  return hasActionLanguage && (hasPlanningLanguage || hasContextRequestLanguage);
}

export function isIntermediateEditStatus(status: AiEditResult["status"]) {
  return status === "plan" || status === "needs_context";
}

function parseEditStatus(value: unknown, patches: FilePatch[] | null): AiEditResult["status"] {
  if (value === "patch" || value === "needs_context" || value === "plan" || value === "blocked") {
    return value;
  }

  return patches === null ? undefined : "patch";
}

function parseNextSearchKeywords(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const keywords = value.filter((keyword): keyword is string => typeof keyword === "string").map(normalizeSearchKeyword).filter(Boolean);
  return keywords.length ? [...new Set(keywords)].slice(0, MAX_PLAN_EDIT_SEARCH_QUERIES) : undefined;
}

export function derivePlanSearchKeywords(userRequest: string, summary: string) {
  const source = `${userRequest}\n${summary}`;
  const keywords: string[] = [];
  const addKeyword = (keyword: string) => {
    const normalized = normalizeSearchKeyword(keyword);

    if (normalized && !keywords.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      keywords.push(normalized);
    }
  };

  // 将常见中文任务意图映射成项目里更容易命中的英文文件名或标识符。
  const mappings: Array<[RegExp, string[]]> = [
    [/(?:\u8def\u7531|\u83dc\u5355|\u8df3\u8f6c|route|router)/i, ["router", "routes"]],
    [/(?:\u9996\u9875|\u4e3b\u9875|home)/i, ["HomeView", "home"]],
    [/(?:\u56fd\u9645\u5316|\u8bed\u8a00|\u7ffb\u8bd1|lang|i18n|locale)/i, ["lang", "i18n", "locale"]],
    [/(?:header|\u5bfc\u822a|\u9875\u5934|\u9876\u90e8)/i, ["Header", "header"]],
    [/(?:\u7ec4\u4ef6|component)/i, ["components"]]
  ];

  for (const [pattern, values] of mappings) {
    if (pattern.test(source)) {
      values.forEach(addKeyword);
    }
  }

  for (const keyword of extractQuotedSearchKeywords(source)) {
    addKeyword(keyword);
  }

  for (const token of source.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) || []) {
    addKeyword(token);
  }

  return keywords.slice(0, MAX_PLAN_EDIT_SEARCH_QUERIES);
}

function deriveFallbackSearchKeywords(userRequest: string, filePath: string | null) {
  const queries: string[] = [];
  const addQuery = (query: string) => {
    const normalized = normalizeSearchKeyword(query);

    if (normalized && !queries.some((item) => item.toLowerCase() === normalized.toLowerCase())) {
      queries.push(normalized);
    }
  };

  for (const token of userRequest.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) || []) {
    addQuery(token);
  }

  for (const keyword of extractQuotedSearchKeywords(userRequest)) {
    addQuery(keyword);
  }

  for (const keyword of derivePlanSearchKeywords(userRequest, "")) {
    addQuery(keyword);
  }

  const commonTerms = ["login", "\u767b\u5f55", "auth", "mock", "api", "\u63a5\u53e3", "user", "\u7528\u6237", "route", "router", "store", "lang", "i18n", "locale", "\u56fd\u9645\u5316", "\u8bed\u8a00", "\u7ffb\u8bd1", "\u83dc\u5355", "\u6743\u9650", "\u8868\u683c", "\u5217\u8868", "\u8be6\u60c5", "\u914d\u7f6e"];

  for (const term of commonTerms) {
    if (userRequest.toLowerCase().includes(term.toLowerCase())) {
      addQuery(term);
    }
  }

  if (filePath) {
    const baseName = filePath.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "";
    addQuery(baseName);
  }

  return queries.slice(0, MAX_PREFLIGHT_EDIT_SEARCH_QUERIES);
}

function shouldRunServerPreflightSearch(userRequest: string, filePath: string | null, pathRetryContext?: EditPathRetryContext) {
  if (pathRetryContext?.reason === "no_file_changes") {
    return true;
  }

  if (!filePath) {
    return true;
  }

  return /(?:按钮|文案|标题|菜单|文本|label|button|title|tooltip|placeholder)/i.test(userRequest);
}

async function generateSearchKeywords(userRequest: string, filePath: string | null, runId: string, onAgentStep?: (step: AgentStep) => void) {
  const fallbackKeywords = deriveFallbackSearchKeywords(userRequest, filePath);

  if (!config.aiApiKey) {
    return fallbackKeywords;
  }

  try {
    const data = await requestJsonChatCompletion({
      model: getActiveModelId(config.aiModel),
      temperature: 0,
      messages: [
        { role: "system", content: AI_SEARCH_KEYWORDS_SYSTEM_PROMPT },
        {
          role: "user",
          content: JSON.stringify(
            {
              selectedFilePath: filePath,
              userRequest
            },
            null,
            2
          )
        }
      ]
    });
    const rawContent = data.choices?.[0]?.message?.content;
    const parsed = rawContent ? (JSON.parse(extractJsonContent(rawContent)) as { keywords?: unknown }) : null;
    const keywords = Array.isArray(parsed?.keywords)
      ? parsed.keywords.filter((keyword): keyword is string => typeof keyword === "string").map(normalizeSearchKeyword).filter(Boolean)
      : [];
    const uniqueKeywords = [...new Set(keywords.map((keyword) => keyword.toLowerCase()))]
      .map((lowercase) => keywords.find((keyword) => keyword.toLowerCase() === lowercase) || lowercase)
      .slice(0, MAX_PREFLIGHT_EDIT_SEARCH_QUERIES);

    if (uniqueKeywords.length) {
      logAi(runId, "searchKeywords.generated", { keywords: uniqueKeywords });
      onAgentStep?.(createAgentStep({ type: "message", content: `Generated search keywords: ${uniqueKeywords.join(", ")}` }));
      return uniqueKeywords;
    }
  } catch (error) {
    logAi(runId, "searchKeywords.fallback", { error: error instanceof Error ? error.message : String(error) });
  }

  return fallbackKeywords;
}

async function runMandatoryEditPreflightSearch(userRequest: string, filePath: string | null, agentContext: AgentContext, runId: string, onAgentStep?: (step: AgentStep) => void) {
  const queries = await generateSearchKeywords(userRequest, filePath, runId, onAgentStep);
  const resultsByQuery: Array<{ query: string; results: Array<{ filePath: string; line: number; content: string }> }> = [];

  for (const query of queries) {
    uniquePush(agentContext.searchQueries, query);
    onAgentStep?.(
      createAgentStep({
        type: "tool_call",
        toolName: "searchCode",
        input: {
          query,
          purpose: `Use searchCode to search workspace code with the model-generated keyword "${query}".`,
          toolDescription: "Search the current workspace code with ripgrep and return matching lines."
        }
      })
    );

    const results = (await searchWorkspaceCode(query))
      .slice(0, MAX_PREFLIGHT_EDIT_SEARCH_RESULTS)
      .map((result) => ({
        filePath: result.filePath,
        line: result.line,
        content: result.content
      }));

    for (const result of results) {
      uniquePush(agentContext.searchResultFiles, result.filePath);
      uniquePush(agentContext.relevantFiles, result.filePath);
    }

    resultsByQuery.push({ query, results });
    logAi(runId, "edit.preflightSearch", { query, resultCount: results.length, files: [...new Set(results.map((result) => result.filePath))].slice(0, 10) });
    onAgentStep?.(
      createAgentStep({
        type: "tool_result",
        toolName: "searchCode",
        output: {
          query,
          toolDescription: "Search the current workspace code with ripgrep and return matching lines.",
          resultCount: results.length,
          files: [...new Set(results.map((result) => result.filePath))].slice(0, 10)
        }
      })
    );

    if (results.length) {
      break;
    }
  }

  return {
    instruction: "The first model-selected search did not find matching files, so fallback project search has been performed. Use fallbackSearchResults to identify existing project files and patterns. If relevant files are found, call readFile(filePath) for the files you need before returning the final edit.",
    queries,
    resultsByQuery
  };
}

// 执行模型计划摘要里提到的关键词搜索，避免"先搜索..."停留在文字计划阶段。
async function runAdditionalEditSearch(queries: string[], agentContext: AgentContext, runId: string, onAgentStep?: (step: AgentStep) => void) {
  const resultsByQuery: Array<{ query: string; results: Array<{ filePath: string; line: number; content: string }> }> = [];

  for (const query of queries) {
    uniquePush(agentContext.searchQueries, query);
    onAgentStep?.(
      createAgentStep({
        type: "tool_call",
        toolName: "searchCode",
        input: {
          query,
          purpose: `Use searchCode to execute the intermediate edit plan with keyword "${query}".`,
          toolDescription: "Search the current workspace code with ripgrep and return matching lines."
        }
      })
    );

    const results = (await searchWorkspaceCode(query))
      .slice(0, MAX_PREFLIGHT_EDIT_SEARCH_RESULTS)
      .map((result) => ({
        filePath: result.filePath,
        line: result.line,
        content: result.content
      }));

    for (const result of results) {
      uniquePush(agentContext.searchResultFiles, result.filePath);
      uniquePush(agentContext.relevantFiles, result.filePath);
    }

    resultsByQuery.push({ query, results });
    logAi(runId, "edit.additionalSearch", { query, resultCount: results.length, files: [...new Set(results.map((result) => result.filePath))].slice(0, 10) });
    onAgentStep?.(
      createAgentStep({
        type: "tool_result",
        toolName: "searchCode",
        output: {
          query,
          toolDescription: "Search the current workspace code with ripgrep and return matching lines.",
          resultCount: results.length,
          files: [...new Set(results.map((result) => result.filePath))].slice(0, 10)
        }
      })
    );
  }

  return resultsByQuery;
}

function getFallbackSearchFilePaths(fallbackSearch: Awaited<ReturnType<typeof runMandatoryEditPreflightSearch>>) {
  const paths: string[] = [];

  for (const group of fallbackSearch.resultsByQuery) {
    for (const result of group.results) {
      uniquePush(paths, result.filePath);
    }
  }

  return paths;
}

function truncateFileForPrompt(content: string) {
  const lines = content.split(/\r?\n/);
  const byLines = lines.slice(0, MAX_READ_FILE_LINES).join("\n");
  const truncatedContent = byLines.length > MAX_READ_FILE_CHARS ? byLines.slice(0, MAX_READ_FILE_CHARS) : byLines;

  return {
    content: truncatedContent,
    truncated: lines.length > MAX_READ_FILE_LINES || byLines.length > MAX_READ_FILE_CHARS || content.length > truncatedContent.length,
    linesRead: Math.min(lines.length, MAX_READ_FILE_LINES),
    totalLines: lines.length
  };
}

async function readEditContextFiles(
  filePaths: string[],
  agentContext: AgentContext,
  runId: string,
  onAgentStep?: (step: AgentStep) => void
) {
  const files: Array<{ filePath: string; content: string; truncated: boolean; linesRead: number; totalLines: number }> = [];

  for (const filePath of filePaths) {
    if (files.length >= MAX_AUTO_EDIT_CONTEXT_FILES) {
      break;
    }

    if (agentContext.filesRead.includes(filePath)) {
      continue;
    }

    onAgentStep?.(
      createAgentStep({
        type: "tool_call",
        toolName: "readFile",
        input: {
          filePath,
          automatic: true,
          purpose: `Use readFile to load ${filePath} as edit context after code search.`,
          toolDescription: "Read a relevant workspace file with line and character limits."
        }
      })
    );

    try {
      const rawContent = await readWorkspaceFile(filePath);
      const truncated = truncateFileForPrompt(rawContent);
      uniquePush(agentContext.filesRead, filePath);
      uniquePush(agentContext.relevantFiles, filePath);
      logAi(runId, "edit.autoRead.ok", { filePath, chars: rawContent.length, linesRead: truncated.linesRead, totalLines: truncated.totalLines, truncated: truncated.truncated });
      onAgentStep?.(
        createAgentStep({
          type: "tool_result",
          toolName: "readFile",
          output: {
            filePath,
            toolDescription: "Read a relevant workspace file with line and character limits.",
            linesRead: truncated.linesRead,
            totalLines: truncated.totalLines,
            truncated: truncated.truncated
          }
        })
      );
      files.push({
        filePath,
        ...truncated
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read file";
      logAi(runId, "edit.autoRead.error", { filePath, error: message });
      onAgentStep?.(createAgentStep({ type: "error", message: `readFile(${filePath}) failed: ${message}` }));
    }
  }

  return files;
}

function createAutomaticEditContextMessage(files: Awaited<ReturnType<typeof readEditContextFiles>>): ChatMessage | null {
  if (!files.length) {
    return null;
  }

  return {
    role: "user",
    content: JSON.stringify({
      automaticContextFiles: files,
      instruction:
        "The server has already read likely edit target files. Use automaticContextFiles as editable context and return a non-empty patches array. Prefer edits search/replace blocks for existing-file changes; use full oldContent/newContent only for true full-file rewrites. Only return patches:null if none of these files can possibly satisfy the request."
    })
  };
}

function createNullPatchRecoveryMessage(options: { summary: string; status: AiEditResult["status"]; automaticContextFiles: Awaited<ReturnType<typeof readEditContextFiles>>; candidateFilePaths: string[]; intermediate: boolean }): ChatMessage {
  const instruction = options.intermediate
    ? "The previous response used an intermediate edit status, not a final edit result. Continue the agent loop now: use nextSearchKeywords, automaticContextFiles, and tools as needed, then return status \"patch\" with a non-empty patches array. Do not finish by restating the plan."
    : "The previous response returned patches:null because more context was needed. The user requested a code fix, so do not finish with patches:null for that reason. Use projectFacts and automaticContextFiles as editable context and return a non-empty patches array. Prefer exact edits search/replace blocks; use full oldContent/newContent only for true full-file rewrites. For framework/API errors, verify dependency versions before choosing imports. If no patch is possible, cite concrete file evidence in the summary.";

  return {
    role: "user",
    content: JSON.stringify({
      previousStatus: options.status,
      previousSummary: options.summary,
      previousResponseWasIntermediate: options.intermediate,
      automaticContextFiles: options.automaticContextFiles,
      candidateFilePaths: [...new Set(options.candidateFilePaths)].slice(0, 20),
      instruction
    })
  };
}

function attachEditScope(result: AiEditResult, agentContext: AgentContext, selectedFilePath: string | null, pathRetryContext?: EditPathRetryContext): AiEditResult {
  const retryCandidateFiles =
    pathRetryContext?.reason === "invalid_paths" || pathRetryContext?.reason === "scope_violation" ? pathRetryContext.validFilePaths : [];
  const editScope = buildEditScope({
    selectedFilePath,
    filesRead: agentContext.filesRead,
    retryCandidateFiles,
    allowNewFiles: true,
    plannedChanges: agentContext.modificationPlan?.files
  });

  return {
    ...result,
    editScope: {
      ...editScope,
      safeEditRecommendation: buildSafeEditRecommendation({
        impactAnalysis: agentContext.impactAnalyses?.at(-1),
        modificationPlan: agentContext.modificationPlan,
        fallbackTargetFiles: selectedFilePath ? [selectedFilePath] : [],
        editableScopeFiles: editScope.allowedExistingFiles
      })
    }
  };
}


async function runFileChatToolLoop(messages: ChatMessage[], agentContext: AgentContext, onAgentStep: ((step: AgentStep) => void) | undefined, deferFinalAnswer: boolean, modelId = config.aiModel): Promise<FileChatToolLoopResult> {
  const runId = createAiRunId("chat");
  const startedAt = Date.now();
  const toolMessages = [...messages];
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, onAgentStep });
  logAi(runId, "start", { userGoal: agentContext.userGoal, contextFiles: agentContext.relevantFiles });

  for (let step = 0; step < MAX_FILE_CHAT_TOOL_STEPS; step += 1) {
    logAi(runId, "completion.request", { step, messageCount: toolMessages.length, tools: true });
    const completionBody = {
      model: modelId,
      temperature: config.aiChatTemperature,
      messages: toolMessages,
      tools: agentToolSchemas,
      tool_choice: "auto"
    };
    const fallbackCompletionBody = {
      ...completionBody,
      tool_choice: "auto"
    };
    const data = await requestChatCompletionWithToolChoiceFallback(completionBody, fallbackCompletionBody, runId);

    const message = data.choices?.[0]?.message;

    if (!message) {
      logAi(runId, "completion.missingMessage");
      throw new HttpError(502, "AI response did not include content");
    }

    if (!message.tool_calls?.length) {
      if (deferFinalAnswer) {
        logAi(runId, "tools.done.deferFinal", { elapsedMs: Date.now() - startedAt, contentPreview: message.content || "" });
        return {
          finalContent: null,
          messages: toolMessages
        };
      }

      logAi(runId, "done", { elapsedMs: Date.now() - startedAt, contentPreview: message.content || "" });
      return {
        finalContent: message.content || "",
        messages: toolMessages
      };
    }

    toolMessages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls
    });

    logAi(runId, "completion.toolCalls", message.tool_calls.map((toolCall) => toolCall.function.name));
    const results = await Promise.all(message.tool_calls.map((toolCall) => executeAgentToolCall(toolCall, toolRuntime)));
    toolMessages.push(...results);
  }

  logAi(runId, "toolSteps.limitReached", { maxSteps: MAX_FILE_CHAT_TOOL_STEPS });
  toolMessages.push({
    role: "user",
    content: "You have already called tools enough times. Do not call any more tools. Answer the user's request using the search results and files already provided."
  });

  if (deferFinalAnswer) {
    return {
      finalContent: null,
      messages: toolMessages
    };
  }

  const data = await requestChatCompletion({
    model: modelId,
    temperature: config.aiChatTemperature,
    messages: toolMessages
  });

  const content = data.choices?.[0]?.message?.content || "I searched the code, but could not produce a final answer.";
  logAi(runId, "done.afterLimit", { elapsedMs: Date.now() - startedAt, contentPreview: content });
  return {
    finalContent: content,
    messages: toolMessages
  };
}

async function generateFileChatAssistantContent(messages: ChatMessage[], agentContext: AgentContext, onAgentStep?: (step: AgentStep) => void, modelId = config.aiModel) {
  const result = await runFileChatToolLoop(messages, agentContext, onAgentStep, false, modelId);
  return result.finalContent || "";
}

async function streamFileChatFinalAnswer(messages: ChatMessage[], onDelta: (delta: string) => void, signal?: AbortSignal, modelId = config.aiModel) {
  const finalMessages: ChatMessage[] = [
    ...messages,
    {
      role: "user",
      content: "Use the gathered context and answer the user's latest request directly. Do not call tools. Do not mention internal tool names unless they are relevant to the answer."
    }
  ];

  try {
    return await requestChatCompletionStream(
      {
        model: modelId,
        temperature: config.aiChatTemperature,
        messages: finalMessages,
        stream: true
      },
      onDelta,
      signal
    );
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }

    logAi("chat-stream", "fallback.nonStreamFinal", { status: error.status, error: error.message });
    const data = await requestChatCompletion({
      model: modelId,
      temperature: config.aiChatTemperature,
      messages: finalMessages
    });
    const text = data.choices?.[0]?.message?.content || "";

    if (!signal?.aborted && text) {
      onDelta(text);
    }

    return signal?.aborted ? "" : text;
  }
}

function parseSearchReplaceEdits(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const edits = value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new HttpError(502, "Failed to parse AI response");
    }

    const edit = item as { search?: unknown; replace?: unknown; replaceAll?: unknown };

    if (typeof edit.search !== "string" || typeof edit.replace !== "string") {
      throw new HttpError(502, "Failed to parse AI response");
    }

    return {
      search: edit.search,
      replace: edit.replace,
      replaceAll: typeof edit.replaceAll === "boolean" ? edit.replaceAll : undefined
    };
  });

  return edits.length ? edits : undefined;
}

function parsePatchFilePath(change: {
  path?: unknown;
  filePath?: unknown;
  file?: unknown;
  filename?: unknown;
  targetPath?: unknown;
  relativePath?: unknown;
  file_path?: unknown;
  target_file?: unknown;
  target?: unknown;
}) {
  for (const value of [change.filePath, change.path, change.file, change.filename, change.targetPath, change.relativePath, change.file_path, change.target_file, change.target]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

export function parseAiEditResult(rawContent: string): AiEditResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonContent(rawContent));
  } catch {
    console.error("Failed to parse AI edit response JSON:", rawContent.slice(0, 1000));
    throw new HttpError(502, "Failed to parse AI response");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(502, "Failed to parse AI response");
  }

  const result = parsed as {
    status?: unknown;
    summary?: unknown;
    patches?: unknown;
    files?: unknown;
    changes?: unknown;
    newContent?: unknown;
    nextSearchKeywords?: unknown;
    commandsToRun?: unknown;
  };

  if (typeof result.summary !== "string") {
    console.error("Failed to parse AI edit response summary:", JSON.stringify(parsed).slice(0, 1000));
    throw new HttpError(502, "Failed to parse AI response");
  }

  const planSummary = result.summary;

  if (result.patches === null || result.files === null || result.newContent === null) {
    const patches = null;
    return {
      status: parseEditStatus(result.status, patches),
      summary: planSummary,
      patches,
      nextSearchKeywords: parseNextSearchKeywords(result.nextSearchKeywords),
      commandsToRun: parseCommandsToRun(result.commandsToRun)
    };
  }

  const fileChanges = Array.isArray(result.patches) ? result.patches : Array.isArray(result.files) ? result.files : Array.isArray(result.changes) ? result.changes : null;

  if (fileChanges) {
    const patches = fileChanges.map((file) => {
      if (!file || typeof file !== "object") {
        console.error("Failed to parse AI edit response file item:", JSON.stringify(file).slice(0, 1000));
        throw new HttpError(502, "Failed to parse AI response");
      }

      const change = file as {
        path?: unknown;
        filePath?: unknown;
        file?: unknown;
        filename?: unknown;
        targetPath?: unknown;
        relativePath?: unknown;
        oldContent?: unknown;
        newContent?: unknown;
        content?: unknown;
        summary?: unknown;
        edits?: unknown;
        status?: unknown;
        action?: unknown;
        operation?: unknown;
      };
      const path = parsePatchFilePath(change);
      const edits = parseSearchReplaceEdits(change.edits);
      const status = parsePatchStatus(change);
      const isDelete = isDeletePatchStatus(status);
      const oldContent = typeof change.oldContent === "string" ? change.oldContent : edits || isDelete ? "" : undefined;
      const hasFullNewContent = typeof change.newContent === "string" || typeof change.content === "string";
      const newContent = typeof change.newContent === "string" ? change.newContent : typeof change.content === "string" ? change.content : "";
      const summary = typeof change.summary === "string" ? change.summary : planSummary;

      if (!path || typeof oldContent !== "string" || (!isDelete && !edits && !hasFullNewContent)) {
        console.error("Failed to parse AI edit response file shape:", JSON.stringify(file).slice(0, 1000));
        throw new HttpError(502, "Failed to parse AI response");
      }

      return {
        filePath: path,
        status,
        oldContent,
        newContent,
        summary,
        edits
      };
    });

    return {
      status: parseEditStatus(result.status, patches),
      summary: planSummary,
      patches,
      nextSearchKeywords: parseNextSearchKeywords(result.nextSearchKeywords),
      commandsToRun: parseCommandsToRun(result.commandsToRun)
    };
  }

  if (typeof result.newContent === "string") {
    console.error("Failed to parse AI edit response missing patch path:", JSON.stringify(parsed).slice(0, 1000));
    throw new HttpError(502, "AI edit response is missing patches[].filePath");
  }

  throw new HttpError(502, "Failed to parse AI response");
}

function parseCommandsToRun(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const commands = value.filter((command): command is string => typeof command === "string" && Boolean(command.trim())).map((command) => command.trim());
  return commands.length ? commands : undefined;
}

function parsePatchStatus(change: { status?: unknown; action?: unknown; operation?: unknown }) {
  const rawStatus = [change.status, change.action, change.operation].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  const normalizedStatus = rawStatus?.trim().toLowerCase();

  if (normalizedStatus === "delete" || normalizedStatus === "remove" || normalizedStatus === "removed") {
    return "delete" as const;
  }

  if (normalizedStatus === "create" || normalizedStatus === "new") {
    return "create" as const;
  }

  if (normalizedStatus === "modify" || normalizedStatus === "edit" || normalizedStatus === "update") {
    return "modify" as const;
  }

  return undefined;
}

function isDeletePatchStatus(status: ReturnType<typeof parsePatchStatus>) {
  return status === "delete";
}

function normalizeAiEditResult(rawContent: string) {
  const result = parseAiEditResult(rawContent);

  if (result.patches && result.patches.length === 0) {
    throw new HttpError(502, "AI edit response is missing patches[].filePath");
  }

  return result;
}

export function normalizeLegacySingleFileEdit(rawContent: string, filePath?: string | null, candidateFilePaths: string[] = []): AiEditResult | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(extractJsonContent(rawContent));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const result = parsed as {
    status?: unknown;
    summary?: unknown;
    oldContent?: unknown;
    newContent?: unknown;
    content?: unknown;
    nextSearchKeywords?: unknown;
    commandsToRun?: unknown;
    patches?: unknown;
    files?: unknown;
    changes?: unknown;
  };
  const uniqueCandidates = [...new Set([filePath || "", ...candidateFilePaths].filter(Boolean))];
  const inferredFilePath = uniqueCandidates.length === 1 ? uniqueCandidates[0] : "";

  if (typeof result.summary !== "string" || !inferredFilePath) {
    return null;
  }

  const fileChanges = Array.isArray(result.patches) ? result.patches : Array.isArray(result.files) ? result.files : Array.isArray(result.changes) ? result.changes : null;
  const legacyChange = fileChanges?.length === 1 && fileChanges[0] && typeof fileChanges[0] === "object" ? (fileChanges[0] as { oldContent?: unknown; newContent?: unknown; content?: unknown; summary?: unknown; edits?: unknown }) : null;
  const changeEdits = legacyChange ? parseSearchReplaceEdits(legacyChange.edits) : undefined;
  const newContent = legacyChange
    ? typeof legacyChange.newContent === "string"
      ? legacyChange.newContent
      : typeof legacyChange.content === "string"
      ? legacyChange.content
      : ""
    : typeof result.newContent === "string"
    ? result.newContent
    : typeof result.content === "string"
    ? result.content
    : "";

  if (!newContent && !changeEdits) {
    return null;
  }

  // 兼容旧版单文件协议：模型漏掉 filePath 时，使用已选文件或唯一候选文件补出路径。
  const patches: FilePatch[] = [
    {
      filePath: inferredFilePath,
      oldContent: typeof legacyChange?.oldContent === "string" ? legacyChange.oldContent : typeof result.oldContent === "string" ? result.oldContent : changeEdits ? "" : "",
      newContent,
      summary: typeof legacyChange?.summary === "string" ? legacyChange.summary : result.summary,
      edits: changeEdits
    }
  ];

  return {
    status: parseEditStatus(result.status, patches),
    summary: result.summary,
    patches,
    nextSearchKeywords: parseNextSearchKeywords(result.nextSearchKeywords),
    commandsToRun: parseCommandsToRun(result.commandsToRun)
  };
}

async function normalizeAiEditResultWithRepair(rawContent: string, filePath?: string | null, runId = "edit", candidateFilePaths: string[] = []) {
  try {
    return normalizeAiEditResult(rawContent);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 502) {
      throw error;
    }

    const legacySingleFileEdit = normalizeLegacySingleFileEdit(rawContent, filePath, candidateFilePaths);

    if (legacySingleFileEdit) {
      logAi(runId, "edit.parse.legacySingleFile", { patches: legacySingleFileEdit.patches?.map((file) => file.filePath) || null });
      return legacySingleFileEdit;
    }

    logAi(runId, "edit.parse.repair.start", { rawPreview: rawContent });
    const repairResponse = await requestJsonChatCompletion({
      model: getActiveModelId(config.aiModel),
      temperature: config.aiEditTemperature,
      messages: [
        {
          role: "system",
          content: [
            "You repair malformed AI edit responses for a local code editor.",
            "Return ONLY valid JSON.",
            "Do not change the intended code content except to make it valid JSON.",
            "The required schema is:",
            '{"status":"patch|needs_context|plan|blocked","summary":"short summary","patches":[{"filePath":"existing/workspace/path","status":"modify|create","oldContent":"exact original file content for full rewrite or empty for local edits","newContent":"full updated file content for full rewrite/new files or empty for local edits","edits":[{"search":"exact existing text","replace":"replacement text"}],"summary":"short file-level summary"}],"nextSearchKeywords":["optional keyword"],"commandsToRun":["optional validation command"]}',
            "The selected file is optional context, not a required edit target.",
            "Prefer edits search/replace blocks for existing-file modifications. Use full newContent only when the whole file must be rewritten.",
            "For a whole-file deletion, do not create a patch. Return patches:null with a summary telling the agent to use runCommand so the runtime can request user approval before deletion.",
            "For an existing file, choose filePath from candidateFilePaths. For a genuinely new file requested by the user, use a safe workspace-relative path.",
            "If the malformed response uses legacy single-file output, convert it to the required patches array with explicit patches[].filePath inferred from selectedFilePath or candidateFilePaths.",
            "Do not preserve legacy path aliases such as path, file, filename, targetPath, relativePath, file_path, target_file, or target; normalize them to filePath.",
            "Do not return top-level oldContent, newContent, or content; those fields must be inside patches[].",
            "If the original response needs more search/read work, return status \"needs_context\" or \"plan\" with patches:null and nextSearchKeywords.",
            "If the original response says the edit cannot be done, return {\"status\":\"blocked\",\"summary\":\"reason\",\"patches\":null}."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              selectedFilePath: filePath || null,
              candidateFilePaths: [...new Set(candidateFilePaths.filter(Boolean))],
              malformedResponse: rawContent
            },
            null,
            2
          )
        }
      ]
    });
    const repairedContent = repairResponse.choices?.[0]?.message?.content;

    if (!repairedContent) {
      logAi(runId, "edit.parse.repair.empty");
      throw error;
    }

    try {
      const result = normalizeAiEditResult(repairedContent);
      logAi(runId, "edit.parse.repair.ok", { patches: result.patches?.map((file) => file.filePath) || null });
      return result;
    } catch {
      console.error("Failed to parse repaired AI edit response:", repairedContent.slice(0, 1000));
      logAi(runId, "edit.parse.repair.failed", { repairedPreview: repairedContent });
      throw error;
    }
  }
}

async function generateAiEditWithTools(
  filePath: string | null,
  content: string,
  userRequest: string,
  onAgentStep?: (step: AgentStep) => void,
  pathRetryContext?: EditPathRetryContext,
  initialModificationPlan?: StructuredModificationPlan
): Promise<AiEditResult> {
  const runId = createAiRunId("edit");
  const startedAt = Date.now();
  const contextPaths = filePath ? [filePath] : [];
  const [availableCommands, recentFailedCommand, projectFacts, projectRules, projectMemoryPrompt] = await Promise.all([
    getAvailableCommandsForPrompt(),
    Promise.resolve(null).then(formatCommandFailureForPrompt),
    getProjectFactsForPrompt(),
    getProjectRulesForPrompt(contextPaths),
    getRelevantProjectMemoryPrompt({ userRequest, contextPaths, plannedFiles: contextPaths })
  ]);
  const agentContext: AgentContext = {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: filePath ? [filePath] : [],
    modificationPlan: initialModificationPlan ? structuredClone(initialModificationPlan) : undefined,
    isSubagent: false,
    parentRunId: null
  };
  const lockedModificationPlan = initialModificationPlan ? structuredClone(initialModificationPlan) : undefined;
  logAi(runId, "start", { userGoal: userRequest, selectedFile: filePath, selectedFileChars: content.length, pathRetryContext });
  const toolMessages: ChatMessage[] = [
    { role: "system", content: [AI_MULTI_FILE_EDIT_SYSTEM_PROMPT, projectMemoryPrompt].filter(Boolean).join("\n\n") },
    {
      role: "user",
      content: JSON.stringify(
        {
          selectedFile: filePath ? { path: filePath, content } : null,
          availableCommands,
          projectFacts,
          projectRules,
          recentFailedCommand,
          fallbackSearch: null,
          pathRetryContext: pathRetryContext
            ? {
                ...pathRetryContext,
                instruction:
                  pathRetryContext.reason === "no_file_changes"
                    ? "Your previous edit response returned patches:null and could not be applied. The user's request requires code changes. Use projectFacts and inspectProject for framework/API errors, search/read the relevant files if needed, then return a non-empty patches array. Prefer edits search/replace blocks; use full oldContent/newContent only for true full-file rewrites. Only return patches:null if the request is truly impossible or unsafe and cite concrete file evidence in summary."
                    : pathRetryContext.reason === "stale_full_rewrite"
                    ? "Your previous edit returned a full-file rewrite based on stale or truncated content. Do not return full oldContent/newContent again. Regenerate using edits search/replace blocks copied exactly from the file context. If a full-file rewrite is unavoidable, first read the missing file ranges so oldContent is the exact current full file."
                    : pathRetryContext.reason === "scope_violation"
                    ? "Your previous edit response touched files outside the approved editable scope. Regenerate the patch using only validFilePaths for existing-file changes. If a new file is necessary, place it next to a validFilePaths entry. Do not include opportunistic cleanup or unrelated refactors."
                    : "Your previous edit response used file paths that do not exist in the workspace. Regenerate the full edit plan using only paths from validFilePaths."
              }
            : null,
          userRequest
        },
        null,
        2
      )
    }
  ];
  const toolRuntime = createAgentToolRuntime({ agentContext, runId, onAgentStep });
  let nullPatchRecoveryAttempts = 0;

  // 所有待审查补丁入口都先执行 Pattern Finder，并自动读取候选，避免此链路绕过连续 Agent 的编辑门禁。
  const patternPreflightCall: AgentToolCall = {
    id: "preflight-pattern-finder",
    type: "function",
    function: {
      name: "findSimilarPatterns",
      arguments: JSON.stringify({ taskDescription: userRequest, targetPath: filePath || undefined, limit: 3 })
    }
  };
  const patternPreflightResult = await executeAgentToolCall(patternPreflightCall, toolRuntime);
  toolMessages.push(patternPreflightResult);
  const patternContextFiles = await readEditContextFiles(agentContext.patternCandidateFiles || [], agentContext, runId, onAgentStep);
  toolMessages.push({
    role: "user",
    content: JSON.stringify({
      patternFinderPreflight: JSON.parse(patternPreflightResult.content),
      automaticPatternContextFiles: patternContextFiles,
      instruction:
        "The server completed Pattern Finder before patch generation. Reuse the returned candidates and automaticPatternContextFiles as the project's reference implementation; only call further tools when more context is necessary."
    })
  });

  // 先做一次服务端预搜索，降低 provider 不支持强制 tool_choice 时卡在"需要先搜索"的概率。
  if (shouldRunServerPreflightSearch(userRequest, filePath, pathRetryContext)) {
    const preflightSearch = await runMandatoryEditPreflightSearch(userRequest, filePath, agentContext, runId, onAgentStep);
    const automaticContextFiles = await readEditContextFiles(getFallbackSearchFilePaths(preflightSearch), agentContext, runId, onAgentStep);

    toolMessages.push({
      role: "user",
      content: JSON.stringify({
        fallbackSearch: preflightSearch,
        automaticContextFiles,
        instruction:
          "The server already performed a preflight search before the first model step. Use fallbackSearch and automaticContextFiles as context, continue calling tools if needed, and return a non-empty patches array instead of stopping at a search plan."
      })
    });
  }

  for (let step = 0; step < MAX_FILE_CHAT_TOOL_STEPS; step += 1) {
    const forceInitialSearch = false;
    logAi(runId, "completion.request", { step, messageCount: toolMessages.length, tools: true, forceInitialSearch });
    const completionBody = {
      model: getActiveModelId(config.aiModel),
      temperature: config.aiEditTemperature,
      messages: toolMessages,
      tools: agentToolSchemas,
      tool_choice: forceInitialSearch ? { type: "function", function: { name: "searchCode" } } : "auto"
    };
    const fallbackCompletionBody = {
      ...completionBody,
      tool_choice: "auto"
    };
    const data = forceInitialSearch ? await requestJsonChatCompletionWithToolChoiceFallback(completionBody, fallbackCompletionBody, runId) : await requestJsonChatCompletion(completionBody);

    const message = data.choices?.[0]?.message;

    if (!message) {
      logAi(runId, "completion.missingMessage");
      throw new HttpError(502, "AI response did not include content");
    }

    if (!message.tool_calls?.length) {
      if (!message.content) {
        logAi(runId, "completion.emptyContent");
        throw new HttpError(502, "AI response did not include content");
      }

      const result = await normalizeAiEditResultWithRepair(
        message.content,
        filePath,
        runId,
        [...agentContext.filesRead, ...agentContext.searchResultFiles, ...(pathRetryContext?.validFilePaths || [])]
      );

      const intermediateStatus = result.patches === null && isIntermediateEditStatus(result.status);
      const contextRequestSummary = result.patches === null && isIntermediateEditPlanSummary(result.summary);
      const shouldContinueEditLoop = intermediateStatus || contextRequestSummary;
      const canRecoverNullPatch = result.patches === null && (result.status !== "blocked" || contextRequestSummary);

      if (result.patches?.length && !agentContext.modificationPlan) {
        logAi(runId, "edit.modificationPlan.required", { files: result.patches.map((patch) => patch.filePath) });
        toolMessages.push({
          role: "user",
          content: JSON.stringify({
            candidateFiles: result.patches.map((patch) => ({ filePath: patch.filePath, changeKind: patch.status })),
            instruction:
              "Before the server can create a pending patch, call planFileChanges for the complete candidate file set. Include each file's workspace-relative path, create/modify kind, responsibility, and reason. Then return the patch again without expanding the plan from the patch result."
          })
        });
        continue;
      }

      if (canRecoverNullPatch && nullPatchRecoveryAttempts < MAX_NULL_PATCH_RECOVERY_ATTEMPTS) {
        nullPatchRecoveryAttempts += 1;
        const planSearchKeywords = shouldContinueEditLoop ? result.nextSearchKeywords?.length ? result.nextSearchKeywords : derivePlanSearchKeywords(userRequest, result.summary) : [];
        const additionalSearchResults = planSearchKeywords.length ? await runAdditionalEditSearch(planSearchKeywords, agentContext, runId, onAgentStep) : [];
        const additionalSearchFilePaths = additionalSearchResults.flatMap((group) => group.results.map((item) => item.filePath));
        const contextFilePaths = [...new Set([...(additionalSearchFilePaths.length ? additionalSearchFilePaths : agentContext.searchResultFiles), ...(pathRetryContext?.validFilePaths || [])])];
        const automaticContextFiles = await readEditContextFiles(contextFilePaths, agentContext, runId, onAgentStep);
        const candidateFilePaths = [...agentContext.filesRead, ...agentContext.searchResultFiles, ...(pathRetryContext?.validFilePaths || [])];

        logAi(runId, "edit.nullPatch.recover", {
          attempt: nullPatchRecoveryAttempts,
          status: result.status,
          summary: result.summary,
          intermediateStatus,
          contextRequestSummary,
          planSearchKeywords,
          automaticContextFiles: automaticContextFiles.map((file) => file.filePath),
          candidateFileCount: candidateFilePaths.length
        });
        onAgentStep?.(
          createAgentStep({
            type: "message",
            content: shouldContinueEditLoop
              ? "Model returned an intermediate edit status instead of file changes. Continuing the agent loop and patch generation."
              : automaticContextFiles.length
              ? `Model requested more context. Automatically read ${automaticContextFiles.length} file(s) and continuing patch generation.`
              : "Model requested more context. Continuing with a stronger instruction to call tools or return a concrete patch."
          })
        );
        toolMessages.push(
          createNullPatchRecoveryMessage({
            summary: result.summary,
            status: result.status,
            automaticContextFiles,
            candidateFilePaths,
            intermediate: shouldContinueEditLoop
          })
        );
        continue;
      }

      logAi(runId, "done", { elapsedMs: Date.now() - startedAt, patches: result.patches?.map((file) => file.filePath) || null, summary: result.summary });
      return attachEditScope(result, agentContext, filePath, pathRetryContext);
    }

    toolMessages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: message.tool_calls
    });

    logAi(runId, "completion.toolCalls", message.tool_calls.map((toolCall) => toolCall.function.name));
    const results = await Promise.all(message.tool_calls.map((toolCall) => executeAgentToolCall(toolCall, toolRuntime)));
    // 外层 proposePatch 传入的计划是权威安全边界，内层模型不能在生成过程中扩大它。
    if (lockedModificationPlan) agentContext.modificationPlan = structuredClone(lockedModificationPlan);
    toolMessages.push(...results);

    if (agentContext.searchResultFiles.length && !agentContext.filesRead.length) {
      const contextMessage = createAutomaticEditContextMessage(await readEditContextFiles(agentContext.searchResultFiles, agentContext, runId, onAgentStep));

      if (contextMessage) {
        toolMessages.push(contextMessage);
      }
    }

    if (forceInitialSearch && !agentContext.searchResultFiles.length) {
      const fallbackSearch = await runMandatoryEditPreflightSearch(userRequest, filePath, agentContext, runId, onAgentStep);
      const automaticContextFiles = await readEditContextFiles(getFallbackSearchFilePaths(fallbackSearch), agentContext, runId, onAgentStep);
      toolMessages.push({
        role: "user",
        content: JSON.stringify({
          fallbackSearch,
          automaticContextFiles,
          instruction:
            "The initial discovery step did not find matching files. If automaticContextFiles is non-empty, use those files as context and return a non-empty patches array. Prefer edits search/replace blocks for existing-file changes; use full oldContent/newContent only for true full-file rewrites. If it is empty, use fallbackSearch results and call readFile for relevant files before returning the final edit."
        })
      });
    }
  }

  logAi(runId, "toolSteps.limitReached", { maxSteps: MAX_FILE_CHAT_TOOL_STEPS });
  toolMessages.push({
    role: "user",
    content: "You have already called tools enough times. Do not call any more tools. Return the final JSON edit response using the selected file and tool results already provided."
  });

  const data = await requestJsonChatCompletion({
    model: getActiveModelId(config.aiModel),
    temperature: config.aiEditTemperature,
    messages: toolMessages
  });

  const rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    throw new HttpError(502, "AI response did not include content");
  }

  const result = await normalizeAiEditResultWithRepair(
    rawContent,
    filePath,
    runId,
    [...agentContext.filesRead, ...agentContext.searchResultFiles, ...(pathRetryContext?.validFilePaths || [])]
  );
  if (result.patches?.length && !agentContext.modificationPlan) {
    throw new HttpError(428, "A structured modification plan is required before patch generation. Call planFileChanges and retry.");
  }
  logAi(runId, "done.afterLimit", { elapsedMs: Date.now() - startedAt, patches: result.patches?.map((file) => file.filePath) || null, summary: result.summary });
  return attachEditScope(result, agentContext, filePath, pathRetryContext);
}

export async function generateAiEdit(
  filePath: string | null,
  content: string,
  userRequest: string,
  onAgentStep?: (step: AgentStep) => void,
  pathRetryContext?: EditPathRetryContext,
  initialModificationPlan?: StructuredModificationPlan
): Promise<AiEditResult> {
  const runId = createAiRunId("edit-simple");
  const startedAt = Date.now();
  if (!config.aiApiKey) {
    throw new HttpError(400, "AI_API_KEY is required to generate edits");
  }

  if (onAgentStep) {
    return generateAiEditWithTools(filePath, content, userRequest, onAgentStep, pathRetryContext, initialModificationPlan);
  }

  if (!filePath) {
    return generateAiEditWithTools(null, content, userRequest, undefined, pathRetryContext, initialModificationPlan);
  }

  const [availableCommands, recentFailedCommand, projectFacts, projectRules, projectMemoryPrompt] = await Promise.all([
    getAvailableCommandsForPrompt(),
    Promise.resolve(null).then(formatCommandFailureForPrompt),
    getProjectFactsForPrompt(),
    getProjectRulesForPrompt([filePath]),
    getRelevantProjectMemoryPrompt({ userRequest, contextPaths: [filePath], plannedFiles: [filePath] })
  ]);
  logAi(runId, "start", { userGoal: userRequest, selectedFile: filePath, selectedFileChars: content.length });

  logAi(runId, "completion.request", { messageCount: 2, tools: false });
  const data = await requestJsonChatCompletion({
    model: getActiveModelId(config.aiModel),
    temperature: config.aiEditTemperature,
    messages: [
      { role: "system", content: [AI_SYSTEM_PROMPT, projectMemoryPrompt].filter(Boolean).join("\n\n") },
      {
        role: "user",
        content: JSON.stringify(
          {
            ...JSON.parse(buildUserPrompt(filePath, content, userRequest, availableCommands, recentFailedCommand)),
            projectFacts,
            projectRules
          },
          null,
          2
        )
      }
    ]
  });

  const rawContent = data.choices?.[0]?.message?.content;

  if (!rawContent) {
    logAi(runId, "completion.emptyContent");
    throw new HttpError(502, "AI response did not include content");
  }

  const result = await normalizeAiEditResultWithRepair(rawContent, filePath, runId);
  logAi(runId, "done", { elapsedMs: Date.now() - startedAt, patches: result.patches?.map((file) => file.filePath) || null, summary: result.summary });
  const editScope = buildEditScope({
    selectedFilePath: filePath,
    filesRead: filePath ? [filePath] : [],
    allowNewFiles: false
  });
  return {
    ...result,
    editScope: {
      ...editScope,
      safeEditRecommendation: buildSafeEditRecommendation({
        modificationPlan: filePath
          ? {
              id: `selected-file-plan-${Date.now().toString(36)}`,
              taskDescription: userRequest,
              files: [{ filePath, changeKind: "modify", responsibility: "用户选中的编辑目标", reason: "显式选中文件用于本次修改" }],
              createdAt: Date.now()
            }
          : undefined,
        fallbackTargetFiles: filePath ? [filePath] : [],
        editableScopeFiles: editScope.allowedExistingFiles
      })
    }
  };
}

export async function generateFileChatReply(contextFiles: ChatContextFile[], history: FileChatMessage[], userRequest: string, chatId?: string, onAgentStep?: (step: AgentStep) => void, modelId = config.aiModel) {
  if (!config.aiApiKey) {
    return [
      `Received: ${userRequest}`,
      "",
      "AI_API_KEY is not configured, so this is a local mock response. Configure an OpenAI-compatible provider to get real AI replies."
    ].join("\n");
  }

  const recentHistory = history.slice(-16).map((message) => ({
    role: message.role,
    content: message.content
  }));
  const contextPaths = contextFiles.map((file) => file.path);
  const [availableCommands, recentFailedCommand, projectFacts, projectRules, projectMemory] = await Promise.all([
    getAvailableCommandsForPrompt(),
    getLastFailedCommandResultForChat(chatId).then(formatCommandFailureForPrompt),
    getProjectFactsForPrompt(),
    getProjectRulesForPrompt(contextPaths),
    getRelevantProjectMemoryPrompt({ userRequest, contextPaths, plannedFiles: contextPaths })
  ]);

  const agentContext: AgentContext = {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: contextFiles.map((file) => file.path),
    isSubagent: false,
    parentRunId: null
  };

  return generateFileChatAssistantContent([
    { role: "system", content: [AI_FILE_CHAT_SYSTEM_PROMPT, projectMemory].filter(Boolean).join("\n\n") },
    {
      role: "user",
      content: JSON.stringify(
        {
          contextFiles,
          availableCommands,
          projectFacts,
          projectRules,
          recentFailedCommand
        },
        null,
        2
      )
    },
    ...recentHistory,
    { role: "user", content: userRequest }
  ], agentContext, onAgentStep, modelId);
}

async function buildFileChatMessages(contextFiles: ChatContextFile[], history: FileChatMessage[], userRequest: string, chatId?: string): Promise<ChatMessage[]> {
  const recentHistory = history.slice(-16).map((message) => ({
    role: message.role,
    content: message.content
  }));
  const contextPaths = contextFiles.map((file) => file.path);
  const [availableCommands, recentFailedCommand, projectFacts, projectRules, projectMemory] = await Promise.all([
    getAvailableCommandsForPrompt(),
    getLastFailedCommandResultForChat(chatId).then(formatCommandFailureForPrompt),
    getProjectFactsForPrompt(),
    getProjectRulesForPrompt(contextPaths),
    getRelevantProjectMemoryPrompt({ userRequest, contextPaths, plannedFiles: contextPaths })
  ]);

  return [
    { role: "system", content: [AI_FILE_CHAT_SYSTEM_PROMPT, projectMemory].filter(Boolean).join("\n\n") },
    {
      role: "user",
      content: JSON.stringify(
        {
          contextFiles,
          availableCommands,
          projectFacts,
          projectRules,
          recentFailedCommand
        },
        null,
        2
      )
    },
    ...recentHistory,
    { role: "user", content: userRequest }
  ];
}

export async function streamFileChatReply(
  contextFiles: ChatContextFile[],
  history: FileChatMessage[],
  userRequest: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  chatId?: string,
  onAgentStep?: (step: AgentStep) => void,
  modelId = config.aiModel
) {
  if (!config.aiApiKey) {
    const text = [
      `Received: ${userRequest}`,
      "",
      "AI_API_KEY is not configured, so this is a local mock streaming response. Configure an OpenAI-compatible provider to get real AI replies."
    ].join("\n");

    if (!signal?.aborted) {
      onDelta(text);
    }

    return signal?.aborted ? "" : text;
  }

  const agentContext: AgentContext = {
    userGoal: userRequest,
    filesRead: [],
    searchQueries: [],
    searchResultFiles: [],
    relevantFiles: contextFiles.map((file) => file.path),
    isSubagent: false,
    parentRunId: null
  };
  const toolLoop = await runFileChatToolLoop(await buildFileChatMessages(contextFiles, history, userRequest, chatId), agentContext, onAgentStep, true, modelId);

  if (toolLoop.finalContent !== null) {
    if (!signal?.aborted && toolLoop.finalContent) {
      onDelta(toolLoop.finalContent);
    }

    return signal?.aborted ? "" : toolLoop.finalContent;
  }

  return streamFileChatFinalAnswer(toolLoop.messages, onDelta, signal, modelId);
}
