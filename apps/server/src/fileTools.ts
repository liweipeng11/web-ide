import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import type { FileTreeNode } from "./types.js";
import { getWorkspaceRoot } from "./workspaceStore.js";

const IGNORED_NAMES = new Set(["node_modules", ".git", "dist", "build", ".next"]);

type ResolveOptions = {
  allowIgnored?: boolean;
};

function toComparablePath(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function hasIgnoredSegment(relativePath: string) {
  return relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => IGNORED_NAMES.has(segment));
}

export function safeResolve(relativePath = "", options: ResolveOptions = {}) {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    throw new HttpError(400, "No workspace selected");
  }

  if (path.isAbsolute(relativePath)) {
    throw new HttpError(403, "Absolute paths are not allowed");
  }

  if (!options.allowIgnored && hasIgnoredSegment(relativePath)) {
    throw new HttpError(403, "Path is ignored");
  }

  const resolved = path.resolve(workspaceRoot, relativePath);
  const root = path.resolve(workspaceRoot);
  const comparableResolved = toComparablePath(resolved);
  const comparableRoot = toComparablePath(root);

  if (comparableResolved !== comparableRoot && !comparableResolved.startsWith(comparableRoot + path.sep)) {
    throw new HttpError(403, "Path is outside WORKSPACE_ROOT");
  }

  return resolved;
}

function toWorkspaceRelative(absolutePath: string) {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    throw new HttpError(400, "No workspace selected");
  }

  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}

export async function listFiles(dir = "", includeIgnored = false): Promise<FileTreeNode[]> {
  const absoluteDir = safeResolve(dir, { allowIgnored: includeIgnored });
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Directory not found");
    }
    throw error;
  });

  const visibleEntries = entries
    .filter((entry) => includeIgnored || !IGNORED_NAMES.has(entry.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const nodes = await Promise.all(
    visibleEntries.map(async (entry) => {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = toWorkspaceRelative(absolutePath);

      if (entry.isDirectory()) {
        const shouldSkipChildren = includeIgnored && IGNORED_NAMES.has(entry.name);

        return {
          name: entry.name,
          path: relativePath,
          type: "directory" as const,
          children: shouldSkipChildren ? [] : await listFiles(relativePath, includeIgnored)
        };
      }

      return {
        name: entry.name,
        path: relativePath,
        type: "file" as const
      };
    })
  );

  return nodes;
}

export async function readWorkspaceFile(filePath: string, options: ResolveOptions = {}) {
  const absolutePath = safeResolve(filePath, options);
  const stat = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "File not found");
    }
    throw error;
  });

  if (!stat.isFile()) {
    throw new HttpError(400, "Path is not a file");
  }

  return fs.readFile(absolutePath, "utf8");
}

export async function writeWorkspaceFile(filePath: string, content: string) {
  const absolutePath = safeResolve(filePath);
  const stat = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "File not found");
    }
    throw error;
  });

  if (!stat.isFile()) {
    throw new HttpError(400, "Path is not a file");
  }

  await fs.writeFile(absolutePath, content, "utf8");
}

export async function createWorkspaceFile(filePath: string, content: string) {
  const absolutePath = safeResolve(filePath);
  const existing = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (existing) {
    throw new HttpError(409, "File already exists");
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

export async function workspacePathExists(filePath: string) {
  const absolutePath = safeResolve(filePath);
  return fs
    .stat(absolutePath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}
