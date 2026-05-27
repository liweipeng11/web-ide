import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { CommandResult } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

type CommandResultStore = {
  results: Record<string, CommandResult[]>;
};

const commandResultStorePath = path.join(path.dirname(config.stateFilePath), "command-results.json");
const maxStoredResultsPerWorkspace = 20;

function workspaceKey(workspaceRoot = getWorkspaceRoot()) {
  return workspaceRoot || "none";
}

async function readCommandResultStore(): Promise<CommandResultStore> {
  const raw = await fs.readFile(commandResultStorePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (!raw) {
    return { results: {} };
  }

  try {
    const parsed = JSON.parse(raw) as CommandResultStore;
    return parsed && typeof parsed === "object" && parsed.results ? parsed : { results: {} };
  } catch {
    return { results: {} };
  }
}

async function writeCommandResultStore(store: CommandResultStore) {
  await fs.mkdir(path.dirname(commandResultStorePath), { recursive: true });
  await fs.writeFile(commandResultStorePath, JSON.stringify(store, null, 2), "utf8");
}

export async function saveCommandResult(result: CommandResult) {
  const store = await readCommandResultStore();
  const key = workspaceKey(result.cwd);
  const results = store.results[key] || [];

  store.results[key] = [result, ...results].slice(0, maxStoredResultsPerWorkspace);
  await writeCommandResultStore(store);

  return result;
}

export async function getRecentCommandResults() {
  const store = await readCommandResultStore();
  return store.results[workspaceKey()] || [];
}

export async function getLastFailedCommandResult() {
  const results = await getRecentCommandResults();
  return results.find((result) => result.exitCode !== 0) || null;
}

export async function getLastFailedCommandResultForChat(chatId?: string) {
  if (!chatId) {
    return null;
  }

  const results = await getRecentCommandResults();
  return results.find((result) => result.chatId === chatId && result.exitCode !== 0) || null;
}

export function formatCommandFailureForPrompt(result: CommandResult | null) {
  if (!result) {
    return null;
  }

  const errorLog = (result.stderr || result.stdout || "").slice(-6000);

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
