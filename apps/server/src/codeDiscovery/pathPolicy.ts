import path from "node:path";
import { HttpError } from "../errors.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import type { ResolveOptions } from "./types.js";

const IGNORED_NAMES = new Set(["node_modules", ".git", ".ai-agent", ".mini-ai-web-editor", "dist", "build", ".next"]);

function toComparablePath(value: string) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

// 判断路径是否命中忽略规则，避免默认读取依赖、构建产物和运行态日志。
export function hasIgnoredSegment(relativePath: string) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);

  return segments.some((segment, index) => IGNORED_NAMES.has(segment) || (segment === ".mini-ai" && segments[index + 1] === "state"));
}

// 将用户传入路径限制在当前工作区内，并拒绝绝对路径和越界路径。
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

// 统一输出前端和 Agent 期望的 POSIX 风格工作区相对路径。
export function toWorkspaceRelative(absolutePath: string) {
  const workspaceRoot = getWorkspaceRoot();

  if (!workspaceRoot) {
    throw new HttpError(400, "No workspace selected");
  }

  return path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
}
