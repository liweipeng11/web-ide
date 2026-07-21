import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ProjectMemory, ProjectMemoryItem, ProjectMemorySourceRef, ProjectMemoryValidationStatus } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const validationCache = new Map<string, MemoryValidationResult>();

export type MemoryValidationReason = {
  source: ProjectMemorySourceRef;
  status: Exclude<ProjectMemoryValidationStatus, "unverified" | "superseded" | "archived">;
  reason: string;
};

export type MemoryValidationResult = {
  itemId: string;
  status: "valid" | "possibly_stale" | "invalid";
  reasons: MemoryValidationReason[];
  checkedAt: number;
  fromCache: boolean;
};

export type MemoryValidationOptions = {
  workspaceRoot: string;
  currentBranch?: string;
  taskIds?: ReadonlySet<string>;
  now?: number;
  cacheTtlMs?: number;
};

function resolveWorkspacePath(workspaceRoot: string, filePath: string) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, filePath);
  const relative = path.relative(root, target);
  return !relative.startsWith("..") && !path.isAbsolute(relative) ? target : null;
}

function sha256(content: Buffer) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function getBranch(workspaceRoot: string) {
  const result = await execFileAsync("git", ["branch", "--show-current"], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}

async function validateGitCommit(workspaceRoot: string, value: string): Promise<MemoryValidationReason["status"]> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${value}^{commit}`], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
    await execFileAsync("git", ["merge-base", "--is-ancestor", value, "HEAD"], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
    const log = await execFileAsync("git", ["log", "HEAD", "--format=%B", "--fixed-strings", `--grep=${value}`, "-1"], { cwd: workspaceRoot, encoding: "utf8", windowsHide: true });
    return /\brevert(?:ed|s|ing)?\b/i.test(log.stdout) ? "invalid" : "valid";
  } catch {
    return "invalid";
  }
}

async function readDependencyNames(workspaceRoot: string) {
  const raw = await fs.readFile(path.join(workspaceRoot, "package.json"), "utf8");
  const manifest = JSON.parse(raw) as Record<string, unknown>;
  const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  return new Set(sections.flatMap((section) => Object.keys((manifest[section] as Record<string, unknown> | undefined) || {})));
}

async function validateSource(source: ProjectMemorySourceRef, options: MemoryValidationOptions): Promise<MemoryValidationReason> {
  if (source.type === "file" || source.type === "symbol") {
    const sourcePath = source.type === "file" ? source.value : source.filePath;
    if (!sourcePath) return { source, status: "possibly_stale", reason: "symbol_source_has_no_file" };
    const target = resolveWorkspacePath(options.workspaceRoot, sourcePath);
    if (!target) return { source, status: "invalid", reason: "source_path_outside_workspace" };
    try {
      const content = await fs.readFile(target);
      if (source.contentHash && sha256(content) !== source.contentHash.toLowerCase()) {
        return { source, status: "possibly_stale", reason: "file_hash_changed" };
      }
      if (source.type === "symbol") {
        const escaped = source.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!new RegExp(`\\b${escaped}\\b`).test(content.toString("utf8"))) return { source, status: "invalid", reason: "symbol_missing" };
      }
      return { source, status: "valid", reason: "source_exists" };
    } catch (error) {
      return { source, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "invalid" : "possibly_stale", reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "file_missing" : "file_validation_failed" };
    }
  }
  if (source.type === "branch") {
    try {
      const branch = options.currentBranch ?? await getBranch(options.workspaceRoot);
      return branch === source.value
        ? { source, status: "valid", reason: "branch_matches" }
        : { source, status: "possibly_stale", reason: "branch_mismatch" };
    } catch {
      return { source, status: "possibly_stale", reason: "branch_validation_failed" };
    }
  }
  if (source.type === "git_commit") {
    const status = await validateGitCommit(options.workspaceRoot, source.value);
    return status === "valid"
      ? { source, status, reason: "commit_in_current_history" }
      : { source, status, reason: "commit_missing_or_reverted" };
  }
  if (source.type === "dependency") {
    try {
      return (await readDependencyNames(options.workspaceRoot)).has(source.value)
        ? { source, status: "valid", reason: "dependency_exists" }
        : { source, status: "invalid", reason: "dependency_missing" };
    } catch {
      return { source, status: "possibly_stale", reason: "dependency_validation_failed" };
    }
  }
  if (source.type === "task" && options.taskIds) {
    return options.taskIds.has(source.value)
      ? { source, status: "valid", reason: "task_exists" }
      : { source, status: "invalid", reason: "task_missing" };
  }
  return { source, status: "valid", reason: "audit_source_present" };
}

function combineStatus(reasons: MemoryValidationReason[]): MemoryValidationResult["status"] {
  if (reasons.some((reason) => reason.status === "invalid")) return "invalid";
  if (reasons.some((reason) => reason.status === "possibly_stale")) return "possibly_stale";
  return "valid";
}

/** 验证异常被转换为状态，绝不阻断主任务；结果按来源和分支缓存，避免重复昂贵检查。 */
export async function validateMemoryItemSources(item: ProjectMemoryItem, options: MemoryValidationOptions): Promise<MemoryValidationResult> {
  const now = options.now ?? Date.now();
  const cacheKey = JSON.stringify([options.workspaceRoot, item.id, item.updatedAt, options.currentBranch, item.sourceRefs]);
  const cached = validationCache.get(cacheKey);
  if (cached && now - cached.checkedAt < (options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) return { ...cached, fromCache: true };
  try {
    const reasons = await Promise.all(item.sourceRefs.map((source) => validateSource(source, options)));
    const result: MemoryValidationResult = { itemId: item.id, status: combineStatus(reasons), reasons, checkedAt: now, fromCache: false };
    validationCache.set(cacheKey, result);
    return result;
  } catch {
    return { itemId: item.id, status: "possibly_stale", reasons: [], checkedAt: now, fromCache: false };
  }
}

export async function validateProjectMemory(memory: ProjectMemory, options: MemoryValidationOptions) {
  const eligible = memory.items.filter((item) => item.status === "active" || item.status === "stale");
  const results = await Promise.all(eligible.map((item) => validateMemoryItemSources(item, options)));
  const byId = new Map(results.map((result) => [result.itemId, result]));
  const items = memory.items.map((item) => {
    const result = byId.get(item.id);
    if (!result) return item;
    const status = result.status === "invalid" ? "stale" as const : item.status;
    return { ...item, status, validationStatus: result.status, lastValidatedAt: result.checkedAt };
  });
  return { memory: { ...memory, items }, results };
}

export function clearMemoryValidationCache() {
  validationCache.clear();
}
