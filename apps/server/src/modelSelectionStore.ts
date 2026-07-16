import fs from "node:fs/promises";
import { config } from "./config.js";
import type { ModelSelection, ModelSelectionDefaults } from "./contracts/model.js";
import { ProviderError, providerGateway } from "./providers/index.js";
import { appStatePath } from "./statePaths.js";

const preferencesPath = () => appStatePath("model-preferences.json");

function legacySelection(): ModelSelection {
  return { providerId: "openai-compatible", modelId: config.aiModel };
}

export function createLegacyModelDefaults(): ModelSelectionDefaults {
  const selection = legacySelection();
  return { chat: { ...selection }, plan: { ...selection }, act: { ...selection } };
}

function isSelection(value: unknown): value is ModelSelection {
  return Boolean(value && typeof value === "object" && typeof (value as ModelSelection).providerId === "string" && (value as ModelSelection).providerId.trim() && typeof (value as ModelSelection).modelId === "string" && (value as ModelSelection).modelId.trim());
}

export async function readModelDefaults(): Promise<ModelSelectionDefaults> {
  try {
    const parsed = JSON.parse(await fs.readFile(preferencesPath(), "utf8")) as Partial<ModelSelectionDefaults>;
    const fallback = createLegacyModelDefaults();
    return {
      chat: isSelection(parsed.chat) ? parsed.chat : fallback.chat,
      plan: isSelection(parsed.plan) ? parsed.plan : fallback.plan,
      act: isSelection(parsed.act) ? parsed.act : fallback.act
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return createLegacyModelDefaults();
    throw error;
  }
}

export async function writeModelDefaults(defaults: ModelSelectionDefaults) {
  if (!defaults || !isSelection(defaults.chat) || !isSelection(defaults.plan) || !isSelection(defaults.act)) {
    throw new ProviderError("invalid_response", "Chat、Plan 和 Act 默认模型配置不完整", false);
  }
  // 写入前逐项校验，避免保存已移除或能力不匹配的模型。
  await Promise.all([
    providerGateway.assertCompatible(defaults.chat, "chat"),
    providerGateway.assertCompatible(defaults.plan, "plan"),
    providerGateway.assertCompatible(defaults.act, "act")
  ]);
  await fs.mkdir(config.stateDirectory, { recursive: true });
  await fs.writeFile(preferencesPath(), `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
  return defaults;
}

export async function resolveModelSelection(mode: "chat" | "plan" | "act", override?: ModelSelection | null) {
  const selection = override || (await readModelDefaults())[mode];
  await providerGateway.assertCompatible(selection, mode);
  return selection;
}
