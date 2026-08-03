import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { readJsonStateFile, writeJsonStateFile } from "./stateFileStorage.js";

type PersistedState = {
  workspaceRoot?: string | null;
};

let workspaceRoot: string | null = null;

export function getWorkspaceRoot() {
  return workspaceRoot;
}

async function readPersistedState(): Promise<PersistedState> {
  const validate = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace state must be an object");
    return value as PersistedState;
  };
  return await readJsonStateFile<PersistedState>(config.stateFilePath, { allowMissing: true, recover: true, validate })
    ?? await readJsonStateFile<PersistedState>(config.legacyStateFilePath, { allowMissing: true, recover: true, validate })
    ?? {};
}

async function persistWorkspaceRoot(nextWorkspaceRoot: string | null) {
  await writeJsonStateFile(config.stateFilePath, { workspaceRoot: nextWorkspaceRoot });
}

export async function initializeWorkspaceRoot() {
  const persisted = await readPersistedState();

  if (!persisted.workspaceRoot) {
    workspaceRoot = null;
    return workspaceRoot;
  }

  try {
    workspaceRoot = await validateWorkspaceRoot(persisted.workspaceRoot);
  } catch {
    workspaceRoot = null;
  }

  return workspaceRoot;
}

async function validateWorkspaceRoot(nextWorkspaceRoot: string) {
  if (!nextWorkspaceRoot || !path.isAbsolute(nextWorkspaceRoot)) {
    throw new HttpError(400, "Workspace path must be an absolute path");
  }


  const resolved = path.resolve(nextWorkspaceRoot);
  const stat = await fs.stat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Workspace directory not found");
    }
    throw error;
  });

  if (!stat.isDirectory()) {
    throw new HttpError(400, "Workspace path must be a directory");
  }

  return resolved;
}

export async function setWorkspaceRoot(nextWorkspaceRoot: string, options: { persist?: boolean } = {}) {
  workspaceRoot = await validateWorkspaceRoot(nextWorkspaceRoot);

  // 测试可以只切换进程内工作区，避免覆盖真实应用保存的项目地址。
  if (options.persist !== false) {
    await persistWorkspaceRoot(workspaceRoot);
  }

  return workspaceRoot;
}
