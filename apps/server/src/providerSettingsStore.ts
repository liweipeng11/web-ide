import fs from "node:fs/promises";
import { config } from "./config.js";
import { ProviderError } from "./providers/types.js";
import { appStatePath } from "./statePaths.js";

const legacyProviderId = "openai-compatible";
const settingsPath = () => appStatePath("provider-settings.json");

type ProviderType = "openai-compatible";

export type ProviderRuntimeSettings = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
};

export type ProviderSettings = {
  providerId: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  credentialConfigured: boolean;
  credentialPreview: string;
  models: string[];
  enabled: boolean;
};

export type ProviderSettingsInput = {
  providerId?: unknown;
  name?: unknown;
  type?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  models?: unknown;
  enabled?: unknown;
};

export type CreateProviderInput = {
  name?: unknown;
  type?: unknown;
};

export type ProviderConnectionTestResult = {
  available: boolean;
  message: string;
  discoveredModelCount?: number;
  /** Provider `/models` 返回且可用于保存的模型 ID。 */
  models: string[];
};

function normalizeBaseUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ProviderError("invalid_response", "Provider Base URL 不能为空", false);
  const normalized = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(normalized);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new ProviderError("invalid_response", "Provider Base URL 必须是有效的 HTTP 或 HTTPS 地址", false);
  }
  return normalized;
}

function normalizeModels(value: unknown) {
  if (!Array.isArray(value)) throw new ProviderError("invalid_response", "模型列表格式无效", false);
  const models = [...new Set(value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean))];
  if (!models.length) throw new ProviderError("invalid_response", "至少需要配置一个模型", false);
  if (models.some((model) => model.length > 200)) throw new ProviderError("invalid_response", "模型 ID 不能超过 200 个字符", false);
  return models;
}

function normalizeName(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new ProviderError("invalid_response", "提供商名称不能为空", false);
  const name = value.trim();
  if (name.length > 80) throw new ProviderError("invalid_response", "提供商名称不能超过 80 个字符", false);
  return name;
}

function normalizeType(value: unknown): ProviderType {
  if (value === undefined || value === "openai-compatible" || value === "openai") return "openai-compatible";
  throw new ProviderError("invalid_response", "暂不支持该提供商类型", false);
}

function defaultProvider(): ProviderRuntimeSettings {
  return {
    id: legacyProviderId,
    name: "OpenAI Compatible",
    type: "openai-compatible",
    baseUrl: config.aiBaseUrl,
    apiKey: config.aiApiKey,
    models: [...config.aiModels],
    enabled: true
  };
}

function normalizeStoredProvider(value: Record<string, unknown>, index: number): ProviderRuntimeSettings {
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : index === 0 ? legacyProviderId : `provider-${index + 1}`,
    name: normalizeName(value.name || (index === 0 ? "OpenAI Compatible" : `Provider ${index + 1}`)),
    type: normalizeType(value.type),
    baseUrl: normalizeBaseUrl(value.baseUrl),
    apiKey: typeof value.apiKey === "string" ? value.apiKey : "",
    models: normalizeModels(value.models),
    enabled: value.enabled !== false
  };
}

async function readStoredProviders(): Promise<ProviderRuntimeSettings[] | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Record<string, unknown>;
    const rawProviders = Array.isArray(parsed.providers) ? parsed.providers : [parsed];
    const providers = rawProviders
      .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
      .map(normalizeStoredProvider);
    return providers.length ? providers : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeStoredProviders(providers: ProviderRuntimeSettings[]) {
  await fs.mkdir(config.stateDirectory, { recursive: true });
  await fs.writeFile(settingsPath(), `${JSON.stringify({ version: 2, providers }, null, 2)}\n`, "utf8");
}

function applyPrimarySettings(providers: ProviderRuntimeSettings[]) {
  const primary = providers.find((provider) => provider.id === legacyProviderId) || providers[0];
  config.aiBaseUrl = primary.baseUrl;
  config.aiApiKey = primary.apiKey;
  config.aiModels = [...primary.models];
  if (!primary.models.includes(config.aiModel)) config.aiModel = primary.models[0];
}

function toPublicSettings(provider: ProviderRuntimeSettings): ProviderSettings {
  const suffix = provider.apiKey.slice(-4);
  return {
    providerId: provider.id,
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    credentialConfigured: Boolean(provider.apiKey),
    credentialPreview: provider.apiKey ? `••••${suffix}` : "",
    models: [...provider.models],
    enabled: provider.enabled
  };
}

export async function initializeProviderSettings() {
  const providers = await readStoredProviders() || [defaultProvider()];
  applyPrimarySettings(providers);
  return providers;
}

export async function readProviderRuntimeSettings() {
  const providers = await readStoredProviders() || [defaultProvider()];
  applyPrimarySettings(providers);
  return providers;
}

export async function readProviderSettings() {
  return (await readProviderRuntimeSettings()).map(toPublicSettings);
}

export async function writeProviderSettings(input: ProviderSettingsInput) {
  const providers = await readProviderRuntimeSettings();
  const providerId = typeof input.providerId === "string" && input.providerId.trim() ? input.providerId.trim() : providers[0].id;
  const index = providers.findIndex((provider) => provider.id === providerId);
  if (index < 0) throw new ProviderError("invalid_response", `未知 Provider：${providerId}`, false);
  const current = providers[index];
  const submittedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const next: ProviderRuntimeSettings = {
    ...current,
    name: input.name === undefined ? current.name : normalizeName(input.name),
    type: input.type === undefined ? current.type : normalizeType(input.type),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey: submittedKey || current.apiKey,
    models: normalizeModels(input.models),
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled
  };
  if (!next.apiKey) throw new ProviderError("invalid_response", "首次设置 Provider 时必须填写 API Key", false);
  providers[index] = next;
  if (!providers.some((provider) => provider.enabled)) throw new ProviderError("invalid_response", "至少需要保留一个已启用的 Provider", false);
  await writeStoredProviders(providers);
  applyPrimarySettings(providers);
  return { settings: toPublicSettings(next), providers };
}

export async function createProviderSettings(input: CreateProviderInput) {
  const providers = await readProviderRuntimeSettings();
  const name = normalizeName(input.name);
  const type = normalizeType(input.type);
  const baseId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider";
  let id = baseId;
  let suffix = 2;
  while (providers.some((provider) => provider.id === id)) id = `${baseId}-${suffix++}`;
  const provider: ProviderRuntimeSettings = {
    id,
    name,
    type,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: ["gpt-4.1-mini"],
    enabled: true
  };
  providers.push(provider);
  await writeStoredProviders(providers);
  return { settings: toPublicSettings(provider), providers };
}

/** 使用未保存的表单值检测 Provider `/models` 接口，不记录或回传凭据。 */
export async function testProviderConnection(input: ProviderSettingsInput): Promise<ProviderConnectionTestResult> {
  const providers = await readProviderRuntimeSettings();
  const providerId = typeof input.providerId === "string" ? input.providerId : providers[0].id;
  const current = providers.find((provider) => provider.id === providerId);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const submittedKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const apiKey = submittedKey || current?.apiKey || "";
  if (!apiKey) throw new ProviderError("invalid_response", "请先填写 API Key", false);
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return { available: false, message: `连接失败（HTTP ${response.status}）`, models: [] };
    const payload = await response.json().catch(() => null) as { data?: unknown[] } | null;
    // OpenAI 兼容接口的模型项通常为 { id }，过滤异常值以免写入无效模型配置。
    const models = Array.isArray(payload?.data)
      ? [...new Set(payload.data.map((item) => item && typeof item === "object" && "id" in item && typeof item.id === "string" ? item.id.trim() : "").filter((id) => id && id.length <= 200))]
      : [];
    const discoveredModelCount = Array.isArray(payload?.data) ? payload.data.length : undefined;
    return {
      available: true,
      message: discoveredModelCount === undefined ? "连接成功，但未返回模型列表" : `连接成功，发现 ${models.length} 个可用模型`,
      discoveredModelCount,
      models
    };
  } catch (error) {
    const timedOut = error instanceof Error && /timeout/i.test(`${error.name} ${error.message}`);
    return { available: false, message: timedOut ? "连接超时，请检查 API 地址" : "连接失败，请检查 API 地址和网络", models: [] };
  }
}
