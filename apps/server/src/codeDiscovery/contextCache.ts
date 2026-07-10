import fs from "node:fs/promises";
import path from "node:path";
import { hasIgnoredSegment, safeResolve, toWorkspaceRelative } from "./pathPolicy.js";
import type { ContextCache, ContextCacheEntry, ContextCacheKey, ContextCacheReadResult, ContextCacheResourceSignature } from "./types.js";

type SerializableValue = null | boolean | number | string | SerializableValue[] | { [key: string]: SerializableValue };

const PATH_ARGUMENTS = new Set(["path", "filePath"]);
const TEXT_QUERY_ARGUMENTS = new Set(["query", "regex"]);

function normalizePathValue(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function shouldNormalizeTextQuery(toolName: string, name: string, args: Record<string, unknown>) {
  if (!TEXT_QUERY_ARGUMENTS.has(name)) return false;
  if (toolName === "searchCodeRegex") return false;

  // 字面量搜索在大小写敏感模式下，Foo 与 foo 是不同查询，不能复用同一个缓存 key。
  if (toolName === "searchCode" && args.caseSensitive === true) return false;

  return true;
}

function normalizeArgument(toolName: string, name: string, value: unknown, args: Record<string, unknown>): SerializableValue {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    const stringValue = typeof value === "string" ? value.trim() : value;

    if (typeof stringValue === "string" && PATH_ARGUMENTS.has(name)) {
      return normalizePathValue(stringValue);
    }

    if (typeof stringValue === "string" && name === "filePattern") {
      return stringValue.replace(/\\/g, "/").toLowerCase();
    }

    // 仅在语义允许时折叠文本查询大小写，避免大小写敏感搜索误命中旧缓存。
    if (typeof stringValue === "string" && shouldNormalizeTextQuery(toolName, name, args)) {
      return stringValue.toLowerCase();
    }

    return stringValue as SerializableValue;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeArgument(toolName, name, item, args));
  }

  if (typeof value === "object") {
    const normalized: Record<string, SerializableValue> = {};

    for (const [childName, childValue] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
      normalized[childName] = normalizeArgument(toolName, childName, childValue, args);
    }

    return normalized;
  }

  return String(value);
}

function normalizeArgs(toolName: string, args: Record<string, unknown>) {
  const normalized: Record<string, SerializableValue> = {};

  for (const [name, value] of Object.entries(args).sort(([left], [right]) => left.localeCompare(right))) {
    normalized[name] = normalizeArgument(toolName, name, value, args);
  }

  return normalized;
}

async function createResourceSignature(resourcePath: string): Promise<ContextCacheResourceSignature | null> {
  const absolutePath = (() => {
    try {
      return safeResolve(resourcePath);
    } catch {
      return null;
    }
  })();

  if (!absolutePath) return null;

  const stat = await fs.stat(absolutePath).catch(() => null);

  if (!stat || (!stat.isFile() && !stat.isDirectory())) return null;

  return {
    path: toWorkspaceRelative(absolutePath),
    type: stat.isDirectory() ? "directory" : "file",
    mtimeMs: stat.mtimeMs,
    size: stat.size
  };
}

function collectString(value: unknown, output: Set<string>) {
  if (typeof value === "string") {
    output.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectString(item, output);
    return;
  }

  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectString(item, output);
  }
}

function collectFilePathsFromResult(result: unknown) {
  const paths = new Set<string>();

  if (Array.isArray(result)) {
    for (const item of result) collectFilePathsFromResult(item).forEach((filePath) => paths.add(filePath));
    return paths;
  }

  if (!result || typeof result !== "object") return paths;

  const value = result as Record<string, unknown>;

  // 只从明确的路径字段提取文件签名，避免把普通文本内容误判成文件路径。
  for (const field of ["filePath", "path"]) {
    const pathValue = value[field];
    if (typeof pathValue === "string") paths.add(pathValue);
  }

  return paths;
}

function normalizeResourcePaths(resourcePaths: string[]) {
  const candidates = new Set<string>();

  for (const resourcePath of resourcePaths) {
    collectString(resourcePath, candidates);
  }

  return [...candidates]
    .map((filePath) => filePath.trim())
    .filter((filePath) => filePath && !path.isAbsolute(filePath) && !hasIgnoredSegment(filePath));
}

async function createResourceSignatures(resourcePaths: string[]) {
  const signatures: ContextCacheResourceSignature[] = [];

  for (const resourcePath of normalizeResourcePaths(resourcePaths)) {
    const signature = await createResourceSignature(resourcePath);
    if (signature) signatures.push(signature);
  }

  return signatures;
}

async function isEntryFresh(entry: ContextCacheEntry) {
  for (const signature of entry.resourceSignatures) {
    const current = await createResourceSignature(signature.path);

    if (!current || current.type !== signature.type || current.mtimeMs !== signature.mtimeMs || current.size !== signature.size) {
      return false;
    }
  }

  return true;
}

export function createContextCache(): ContextCache {
  const entries = new Map<string, ContextCacheEntry>();

  function describeKey(key: ContextCacheKey) {
    return JSON.stringify({
      toolName: key.toolName,
      args: normalizeArgs(key.toolName, key.args)
    });
  }

  return {
    describeKey,
    async get(key): Promise<ContextCacheReadResult> {
      const cacheKey = describeKey(key);
      const entry = entries.get(cacheKey);

      if (!entry) return { hit: false, stale: false };

      if (!(await isEntryFresh(entry))) {
        entries.delete(cacheKey);
        return { hit: false, stale: true };
      }

      return { hit: true, stale: false, result: entry.result, entry };
    },
    async set(key, result, options = {}) {
      const cacheKey = describeKey(key);
      const explicitPaths = options.resourcePaths || [];
      const resultPaths = [...collectFilePathsFromResult(result)];
      const resourceSignatures = await createResourceSignatures([...explicitPaths, ...resultPaths]);

      entries.set(cacheKey, {
        key,
        result,
        summary: options.summary,
        resourceSignatures,
        createdAt: Date.now()
      });
    }
  };
}
