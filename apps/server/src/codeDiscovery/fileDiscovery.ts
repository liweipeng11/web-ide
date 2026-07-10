import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import type { FileDiscoveryEntry, FileNameSearchResult, ResolveOptions } from "./types.js";
import { hasIgnoredSegment, safeResolve, toWorkspaceRelative } from "./pathPolicy.js";

const DEFAULT_LIST_LIMIT = 500;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_DISCOVERY_LIMIT = 2000;

type ListWorkspaceFilesOptions = ResolveOptions & {
  recursive?: boolean;
  limit?: number;
};

function normalizeLimit(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "limit must be a positive integer");
  }

  return Math.min(value, MAX_DISCOVERY_LIMIT);
}

async function readDirectoryEntries(absoluteDir: string) {
  return fs.readdir(absoluteDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Directory not found");
    }
    throw error;
  });
}

function sortDirectoryEntries(entries: Array<Awaited<ReturnType<typeof readDirectoryEntries>>[number]>) {
  return entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function toDiscoveryEntry(absolutePath: string, entryName: string, type: FileDiscoveryEntry["type"], depth: number): FileDiscoveryEntry {
  return {
    name: entryName,
    path: toWorkspaceRelative(absolutePath),
    type,
    depth
  };
}

/**
 * 列出工作区内的文件和目录。
 * 该能力只读取目录项，不读取文件内容，用于在搜索正文前快速定位候选文件。
 */
export async function listWorkspaceFiles(dir = "", options: ListWorkspaceFilesOptions = {}): Promise<FileDiscoveryEntry[]> {
  const limit = normalizeLimit(options.limit, DEFAULT_LIST_LIMIT);
  const recursive = options.recursive === true;
  const includeIgnored = options.allowIgnored === true;
  const absoluteStartDir = safeResolve(dir, { allowIgnored: includeIgnored });
  const startStat = await fs.stat(absoluteStartDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Directory not found");
    }
    throw error;
  });

  if (!startStat.isDirectory()) {
    throw new HttpError(400, "Path is not a directory");
  }

  const results: FileDiscoveryEntry[] = [];

  async function walk(absoluteDir: string, depth: number) {
    if (results.length >= limit) return;

    const entries = sortDirectoryEntries(await readDirectoryEntries(absoluteDir));

    for (const entry of entries) {
      if (results.length >= limit) return;

      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = toWorkspaceRelative(absolutePath);

      if (!includeIgnored && hasIgnoredSegment(relativePath)) {
        continue;
      }

      const type = entry.isDirectory() ? "directory" : "file";
      results.push(toDiscoveryEntry(absolutePath, entry.name, type, depth));

      // 只在显式递归时继续展开目录，且不跟随符号链接，避免循环遍历。
      if (recursive && entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(absolutePath, depth + 1);
      }
    }
  }

  await walk(absoluteStartDir, 0);
  return results;
}

function scoreFileNameMatch(entry: FileDiscoveryEntry, query: string): FileNameSearchResult | null {
  const normalizedQuery = query.toLowerCase();
  const normalizedName = entry.name.toLowerCase();
  const normalizedPath = entry.path.toLowerCase();
  const extension = path.extname(entry.name).toLowerCase();

  // 扩展名查询要先于普通文件名包含判断，否则 ".vue" 会被当成名称片段命中。
  if (extension && (extension === normalizedQuery || extension.slice(1) === normalizedQuery)) {
    return { ...entry, score: 90, matchedBy: "extension" };
  }

  if (normalizedName === normalizedQuery) {
    return { ...entry, score: 100, matchedBy: "name" };
  }

  if (normalizedName.includes(normalizedQuery)) {
    return { ...entry, score: 80, matchedBy: "name" };
  }

  if (normalizedPath.includes(normalizedQuery)) {
    return { ...entry, score: 50, matchedBy: "path" };
  }

  return null;
}

/**
 * 按文件名、扩展名或路径片段搜索工作区路径。
 * 这里刻意不打开文件正文，避免为了定位入口文件而触发高成本全文搜索。
 */
export async function searchWorkspaceFilesByName(query: string, dir = "", limit = DEFAULT_SEARCH_LIMIT, options: ResolveOptions = {}): Promise<FileNameSearchResult[]> {
  const needle = query.trim();

  if (!needle) {
    return [];
  }

  const boundedLimit = normalizeLimit(limit, DEFAULT_SEARCH_LIMIT);
  const entries = await listWorkspaceFiles(dir, {
    recursive: true,
    limit: MAX_DISCOVERY_LIMIT,
    allowIgnored: options.allowIgnored
  });
  const matches: FileNameSearchResult[] = [];

  for (const entry of entries) {
    const match = scoreFileNameMatch(entry, needle);
    if (match) matches.push(match);
  }

  return matches
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.path.localeCompare(b.path);
    })
    .slice(0, boundedLimit);
}
