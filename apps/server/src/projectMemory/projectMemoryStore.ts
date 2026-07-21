import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { ensureProjectMemoryIsSafeForPersistence } from "./memorySanitizer.js";
import { migrateProjectMemory, normalizeProjectMemory } from "./projectMemoryMigration.js";
import type { ProjectMemory } from "./types.js";

const memoryRelativePath = path.join(".mini-ai", "state", "runtime", "project-memory.json");
const legacyMemoryRelativePath = path.join(".ai-agent", "project-memory.json");
const writeQueues = new Map<string, Promise<unknown>>();

function memoryPath(workspaceRoot: string) {
  return path.join(workspaceRoot, memoryRelativePath);
}

function legacyMemoryPath(workspaceRoot: string) {
  return path.join(workspaceRoot, legacyMemoryRelativePath);
}

async function readOptionalFile(filePath: string) {
  return fs.readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function readProjectMemory(workspaceRoot: string): Promise<ProjectMemory | null> {
  const primary = await readOptionalFile(memoryPath(workspaceRoot));
  const raw = primary ?? await readOptionalFile(legacyMemoryPath(workspaceRoot));
  if (raw === null) return null;

  try {
    return migrateProjectMemory(JSON.parse(raw));
  } catch (error) {
    const detail = error instanceof SyntaxError ? "contains invalid JSON" : `cannot be migrated: ${error instanceof Error ? error.message : "unknown error"}`;
    throw new HttpError(500, `Project memory file ${detail}`);
  }
}

export async function writeProjectMemory(workspaceRoot: string, memory: ProjectMemory): Promise<ProjectMemory> {
  const targetPath = memoryPath(workspaceRoot);
  const normalized = normalizeProjectMemory(memory);
  ensureProjectMemoryIsSafeForPersistence(normalized);
  const previous = writeQueues.get(targetPath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;

    // 先写临时文件再替换，避免进程中断留下半截 JSON；序列化结果始终为 Schema V3。
    await fs.writeFile(temporaryPath, JSON.stringify(normalized, null, 2), "utf8");
    await fs.rename(temporaryPath, targetPath).catch(async (error) => {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    });
    return normalized;
  });

  writeQueues.set(targetPath, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(targetPath) === next) writeQueues.delete(targetPath);
  }
}
