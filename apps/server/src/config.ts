import dotenv from "dotenv";
import path from "node:path";
import { resolveAgentBudgetPolicy } from "./agentBudgetPolicy.js";
import { readCompletionPolicyRollout, readExplicitCompletionRollout, readFeatureFlags } from "./featureFlags.js";
import { readProjectMemoryFeatureFlags } from "./projectMemory/projectMemoryFeatureFlags.js";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
dotenv.config();

const defaultStateDirectory = path.resolve(process.cwd(), "../../.mini-ai/state/web-editor");
const legacyStateDirectory = path.resolve(process.cwd(), "../../.mini-ai-web-editor");

function numberFromEnv(name: string, fallback: number) {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type AgentRepeatToolCallThresholds = {
  warning: number;
  block: number;
};

export type AgentNoProgressPolicy = {
  maxSteps: number;
  recoveryAttempts: number;
};

const DEFAULT_AGENT_REPEAT_TOOL_CALL_THRESHOLDS: AgentRepeatToolCallThresholds = {
  warning: 2,
  block: 3
};

const DEFAULT_AGENT_NO_PROGRESS_POLICY: AgentNoProgressPolicy = {
  maxSteps: 4,
  recoveryAttempts: 1
};

function positiveIntegerFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv) {
  const value = env[name];
  if (value === undefined || value.trim() === "") return fallback;

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 读取完全相同工具调用的分级阈值；关系无效时整体回退，避免出现先阻断、后警告。
 */
export function resolveAgentRepeatToolCallThresholds(env: NodeJS.ProcessEnv = process.env): AgentRepeatToolCallThresholds {
  const warning = positiveIntegerFromEnv(
    "AI_AGENT_REPEAT_WARNING_THRESHOLD",
    DEFAULT_AGENT_REPEAT_TOOL_CALL_THRESHOLDS.warning,
    env
  );
  const block = positiveIntegerFromEnv(
    "AI_AGENT_REPEAT_BLOCK_THRESHOLD",
    DEFAULT_AGENT_REPEAT_TOOL_CALL_THRESHOLDS.block,
    env
  );

  return block > warning
    ? { warning, block }
    : { ...DEFAULT_AGENT_REPEAT_TOOL_CALL_THRESHOLDS };
}

/**
 * 读取无进展熔断策略。恢复次数允许为 0，便于需要快速失败的部署直接启用熔断。
 */
export function resolveAgentNoProgressPolicy(env: NodeJS.ProcessEnv = process.env): AgentNoProgressPolicy {
  const maxSteps = positiveIntegerFromEnv(
    "AI_AGENT_MAX_NO_PROGRESS_STEPS",
    DEFAULT_AGENT_NO_PROGRESS_POLICY.maxSteps,
    env
  );
  const recoveryValue = env.AI_AGENT_RECOVERY_ATTEMPTS;
  const parsedRecoveryAttempts = recoveryValue === undefined || recoveryValue.trim() === ""
    ? DEFAULT_AGENT_NO_PROGRESS_POLICY.recoveryAttempts
    : Number(recoveryValue);
  const recoveryAttempts = Number.isInteger(parsedRecoveryAttempts) && parsedRecoveryAttempts >= 0
    ? parsedRecoveryAttempts
    : DEFAULT_AGENT_NO_PROGRESS_POLICY.recoveryAttempts;

  return { maxSteps, recoveryAttempts };
}

function optionalNumberFromEnv(name: string) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function booleanFromEnv(name: string, fallback: boolean) {
  const value = process.env[name];

  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function stringListFromEnv(name: string) {
  return [...new Set((process.env[name] || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];
}

function modelListFromEnv() {
  const values = (process.env.AI_MODELS || "").split(",").map((value) => value.trim()).filter(Boolean);
  const catalogValues = modelCatalogFromEnv().map((entry) => typeof entry.id === "string" ? entry.id.trim() : "").filter(Boolean);
  const legacyModel = process.env.AI_MODEL || "gpt-4.1-mini";
  return [...new Set([legacyModel, ...values, ...catalogValues])];
}

function modelCatalogFromEnv(): Array<Record<string, unknown>> {
  const raw = process.env.AI_MODEL_CATALOG_JSON;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))) : [];
  } catch {
    return [];
  }
}

const agentRepeatToolCallThresholds = resolveAgentRepeatToolCallThresholds();
const agentNoProgressPolicy = resolveAgentNoProgressPolicy();
const agentBudgetPolicy = resolveAgentBudgetPolicy();

export const config = {
  aiApiKey: process.env.AI_API_KEY || "",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL || "gpt-4.1-mini",
  aiModels: modelListFromEnv(),
  aiModelCatalog: modelCatalogFromEnv(),
  aiInputPricePerMillionTokens: optionalNumberFromEnv("AI_INPUT_PRICE_PER_MILLION_TOKENS"),
  aiOutputPricePerMillionTokens: optionalNumberFromEnv("AI_OUTPUT_PRICE_PER_MILLION_TOKENS"),
  aiCachedInputPricePerMillionTokens: optionalNumberFromEnv("AI_CACHED_INPUT_PRICE_PER_MILLION_TOKENS"),
  aiChatTemperature: numberFromEnv("AI_CHAT_TEMPERATURE", 0.3),
  aiEditTemperature: numberFromEnv("AI_EDIT_TEMPERATURE", 0),
  aiFullIoLogging: booleanFromEnv("AI_FULL_IO_LOGGING", false),
  aiContextWindowTokens: numberFromEnv("AI_CONTEXT_WINDOW_TOKENS", 128_000),
  aiMaxOutputTokens: numberFromEnv("AI_MAX_OUTPUT_TOKENS", 8_192),
  aiContextSafetyMarginTokens: numberFromEnv("AI_CONTEXT_SAFETY_MARGIN_TOKENS", 2_048),
  aiAgentMaxSteps: agentBudgetPolicy.maxSteps,
  aiAgentConvergenceRemainingSteps: agentBudgetPolicy.convergenceRemainingSteps,
  aiAgentForceFinalRemainingSteps: agentBudgetPolicy.forceFinalRemainingSteps,
  aiAgentRepeatWarningThreshold: agentRepeatToolCallThresholds.warning,
  aiAgentRepeatBlockThreshold: agentRepeatToolCallThresholds.block,
  aiAgentMaxNoProgressSteps: agentNoProgressPolicy.maxSteps,
  aiAgentRecoveryAttempts: agentNoProgressPolicy.recoveryAttempts,
  braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
  braveSearchBaseUrl: process.env.BRAVE_SEARCH_BASE_URL || "https://api.search.brave.com/res/v1/web/search",
  externalContextTimeoutMs: numberFromEnv("EXTERNAL_CONTEXT_TIMEOUT_MS", 15_000),
  externalContextMaxResponseBytes: numberFromEnv("EXTERNAL_CONTEXT_MAX_RESPONSE_BYTES", 1_000_000),
  externalContextTrustedDocDomains: stringListFromEnv("EXTERNAL_CONTEXT_TRUSTED_DOC_DOMAINS"),
  externalContextAllowProxyMappedAddresses: booleanFromEnv("EXTERNAL_CONTEXT_ALLOW_PROXY_MAPPED_ADDRESSES", false),
  externalBrowserExecutablePath: process.env.EXTERNAL_BROWSER_EXECUTABLE_PATH || "",
  externalBrowserChannel: process.env.EXTERNAL_BROWSER_CHANNEL || "",
  externalBrowserProxyUrl: process.env.EXTERNAL_BROWSER_PROXY_URL || "",
  stateDirectory: process.env.STATE_DIRECTORY || defaultStateDirectory,
  legacyStateDirectory,
  stateFilePath: process.env.STATE_FILE_PATH || path.join(process.env.STATE_DIRECTORY || defaultStateDirectory, "state.json"),
  legacyStateFilePath: path.join(legacyStateDirectory, "state.json"),
  serverPort: Number(process.env.SERVER_PORT || 3001),
  commandExecutionRetentionLimit: numberFromEnv("COMMAND_EXECUTION_RETENTION_LIMIT", 100),
  commandExecutionRetentionDays: numberFromEnv("COMMAND_EXECUTION_RETENTION_DAYS", 30),
  commandExecutionMaxLogFileBytes: numberFromEnv("COMMAND_EXECUTION_MAX_LOG_FILE_BYTES", 5 * 1024 * 1024),
  commandExecutionMaxWorkspaceLogBytes: numberFromEnv("COMMAND_EXECUTION_MAX_WORKSPACE_LOG_BYTES", 50 * 1024 * 1024),
  featureFlags: readFeatureFlags(),
  explicitCompletionRollout: readExplicitCompletionRollout(),
  completionPolicyRollout: readCompletionPolicyRollout(),
  projectMemoryFeatureFlags: readProjectMemoryFeatureFlags()
};
