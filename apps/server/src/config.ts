import dotenv from "dotenv";
import path from "node:path";
import { readFeatureFlags } from "./featureFlags.js";

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

export const config = {
  aiApiKey: process.env.AI_API_KEY || "",
  aiBaseUrl: process.env.AI_BASE_URL || "https://api.openai.com/v1",
  aiModel: process.env.AI_MODEL || "gpt-4.1-mini",
  aiChatTemperature: numberFromEnv("AI_CHAT_TEMPERATURE", 0.3),
  aiEditTemperature: numberFromEnv("AI_EDIT_TEMPERATURE", 0),
  aiFullIoLogging: booleanFromEnv("AI_FULL_IO_LOGGING", false),
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
  featureFlags: readFeatureFlags()
};
