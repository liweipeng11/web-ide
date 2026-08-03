import { appStatePath, legacyAppStatePath } from "./statePaths.js";
import { readJsonStateFile, writeJsonStateFile } from "./stateFileStorage.js";
import type { CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type CommandResultStore = {
  results: Record<string, CommandResult[]>;
};

const commandResultStorePath = appStatePath("command-results.json");
const legacyCommandResultStorePath = legacyAppStatePath("command-results.json");
const maxStoredResultsPerWorkspace = 20;
let commandResultUpdateQueue: Promise<unknown> = Promise.resolve();

function workspaceKey(workspaceRoot = getWorkspaceRoot()) {
  return workspaceRoot || "none";
}

async function readCommandResultStore(): Promise<CommandResultStore> {
  const validate = (value: unknown) => {
    const results = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<CommandResultStore>).results
      : null;
    if (!results || typeof results !== "object" || Array.isArray(results)) throw new Error("command result state is invalid");
    return { results };
  };
  return await readJsonStateFile<CommandResultStore>(commandResultStorePath, { allowMissing: true, recover: true, validate })
    ?? await readJsonStateFile<CommandResultStore>(legacyCommandResultStorePath, { allowMissing: true, recover: true, validate })
    ?? { results: {} };
}

function enqueueCommandResultUpdate<T>(update: () => Promise<T>) {
  const next = commandResultUpdateQueue.catch(() => undefined).then(update);
  commandResultUpdateQueue = next;
  return next;
}

export async function saveCommandResult(result: CommandResult) {
  return enqueueCommandResultUpdate(async () => {
    const store = await readCommandResultStore();
    const key = workspaceKey(result.cwd);
    const results = store.results[key] || [];
    store.results[key] = [result, ...results].slice(0, maxStoredResultsPerWorkspace);
    await writeJsonStateFile(commandResultStorePath, store);
    return result;
  });
}

export async function getRecentCommandResults() {
  await commandResultUpdateQueue.catch(() => undefined);
  const store = await readCommandResultStore();
  return store.results[workspaceKey()] || [];
}

// 运行中任务的 exitCode 为 null，不能据此推断命令失败。
export function isFailedCommandResult(result: CommandResult) {
  return result.status === "failed" || result.status === "timeout";
}

export async function getLastFailedCommandResult() {
  const results = await getRecentCommandResults();
  return results.find(isFailedCommandResult) || null;
}

export async function getLastFailedCommandResultForChat(chatId?: string) {
  if (!chatId) {
    return null;
  }

  const results = await getRecentCommandResults();
  return results.find((result) => result.chatId === chatId && isFailedCommandResult(result)) || null;
}

export function formatCommandFailureForPrompt(result: CommandResult | null) {
  if (!result) {
    return null;
  }

  const errorLog = (result.summary || result.stderr || result.stdout || "").slice(-6000);

  return [
    "最近执行命令：",
    "",
    result.command,
    "",
    "工作目录：",
    "",
    result.cwd,
    "",
    "退出码：",
    "",
    String(result.exitCode),
    "",
    "错误日志：",
    "",
    errorLog || "(无输出)"
  ].join("\n");
}
