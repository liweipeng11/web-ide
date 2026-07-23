import fs from "node:fs/promises";
import path from "node:path";
import type { ExistenceCandidate, PlannedFileChange, PlannedFileGraph } from "./types.js";

const PLANNED_IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".vue", ".mjs", ".cjs", ".py", ".json"];

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInsideWorkspace(workspaceRoot: string, absolutePath: string) {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * 将模型给出的路径约束为工作区相对路径。
 * 绝对路径仅在确实位于当前工作区内时允许，以兼容模型返回完整路径的情况。
 */
export function normalizePlannedFilePath(workspaceRoot: string, filePath: string) {
  const trimmedPath = filePath.trim();
  if (!trimmedPath) throw new Error("计划文件路径不能为空");
  if (trimmedPath.replaceAll("\\", "/").split("/").includes("..")) {
    throw new Error(`计划文件路径不能包含 ..: ${filePath}`);
  }

  const absolutePath = path.isAbsolute(trimmedPath) ? path.resolve(trimmedPath) : path.resolve(workspaceRoot, trimmedPath);
  if (!isInsideWorkspace(workspaceRoot, absolutePath)) {
    throw new Error(`计划文件路径越出工作区: ${filePath}`);
  }

  const relativePath = normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
  if (!relativePath || relativePath.split("/").includes("..")) {
    throw new Error(`计划文件路径无效: ${filePath}`);
  }
  return relativePath;
}

async function getFileState(absolutePath: string) {
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat) return "missing" as const;
  return stat.isFile() ? ("file" as const) : ("other" as const);
}

/**
 * 根据补丁计划和当前磁盘状态构建虚拟文件图。
 * 状态不一致或同一路径出现冲突操作时直接拒绝，避免用 create 覆盖已有文件。
 */
export async function buildPlannedFileGraph(workspaceRoot: string, changes: PlannedFileChange[]): Promise<PlannedFileGraph> {
  const graph: PlannedFileGraph = {
    creates: new Set<string>(),
    modifies: new Set<string>(),
    deletes: new Set<string>()
  };
  const seenPaths = new Map<string, PlannedFileChange["changeKind"]>();

  for (const change of changes) {
    const normalizedPath = normalizePlannedFilePath(workspaceRoot, change.filePath);
    const pathKey = normalizedPath.toLowerCase();
    const previousKind = seenPaths.get(pathKey);
    if (previousKind && previousKind !== change.changeKind) {
      throw new Error(`同一路径不能同时执行多种变更: ${normalizedPath} (${previousKind}, ${change.changeKind})`);
    }
    if (previousKind) {
      continue;
    }

    const fileState = await getFileState(path.join(workspaceRoot, normalizedPath));
    if (change.changeKind === "create" && fileState !== "missing") {
      throw new Error(`create 目标已经存在，不能覆盖: ${normalizedPath}`);
    }
    if ((change.changeKind === "modify" || change.changeKind === "delete") && fileState !== "file") {
      throw new Error(`${change.changeKind} 目标不是已存在文件: ${normalizedPath}`);
    }

    seenPaths.set(pathKey, change.changeKind);
    if (change.changeKind === "create") graph.creates.add(normalizedPath);
    if (change.changeKind === "modify") graph.modifies.add(normalizedPath);
    if (change.changeKind === "delete") graph.deletes.add(normalizedPath);
  }

  return graph;
}

export function getPlannedChangeKind(graph: PlannedFileGraph, filePath: string) {
  const normalizedPath = normalizeRelativePath(filePath);
  const pathKey = normalizedPath.toLowerCase();
  if ([...graph.creates].some((candidate) => candidate.toLowerCase() === pathKey)) return "create" as const;
  if ([...graph.modifies].some((candidate) => candidate.toLowerCase() === pathKey)) return "modify" as const;
  if ([...graph.deletes].some((candidate) => candidate.toLowerCase() === pathKey)) return "delete" as const;
  return null;
}

/**
 * 按 Node/Vue 常见扩展名与目录 index 规则查询计划创建的 import 候选。
 */
export function resolvePlannedFileCandidates(
  workspaceRoot: string,
  basePath: string,
  graph: PlannedFileGraph
): ExistenceCandidate[] {
  if (!isInsideWorkspace(workspaceRoot, basePath)) return [];

  const candidatePaths = [
    ...PLANNED_IMPORT_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...PLANNED_IMPORT_EXTENSIONS.slice(1).map((extension) => path.join(basePath, `index${extension}`))
  ];
  const candidates: ExistenceCandidate[] = [];
  const seen = new Set<string>();

  for (const absoluteCandidate of candidatePaths) {
    const relativePath = normalizeRelativePath(path.relative(workspaceRoot, absoluteCandidate));
    const plannedPath = [...graph.creates].find((candidate) => candidate.toLowerCase() === relativePath.toLowerCase());
    if (!plannedPath || seen.has(plannedPath.toLowerCase())) continue;
    seen.add(plannedPath.toLowerCase());
    candidates.push({
      path: plannedPath,
      detail: path.posix.basename(plannedPath).startsWith("index.") ? "计划创建的目录 index 文件" : "计划创建的 import 目标"
    });
  }

  return candidates;
}
