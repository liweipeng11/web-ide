import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { HttpError } from "./errors.js";

type PersistedState = {
  workspaceRoot?: string | null;
};

let workspaceRoot: string | null = null;

export function getWorkspaceRoot() {
  return workspaceRoot;
}

async function readPersistedState(): Promise<PersistedState> {
  const raw = await fs.readFile(config.stateFilePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as PersistedState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function persistWorkspaceRoot(nextWorkspaceRoot: string | null) {
  await fs.mkdir(path.dirname(config.stateFilePath), { recursive: true });
  await fs.writeFile(config.stateFilePath, JSON.stringify({ workspaceRoot: nextWorkspaceRoot }, null, 2), "utf8");
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

export async function setWorkspaceRoot(nextWorkspaceRoot: string) {
  workspaceRoot = await validateWorkspaceRoot(nextWorkspaceRoot);
  await persistWorkspaceRoot(workspaceRoot);
  return workspaceRoot;
}
