import fs from "node:fs/promises";
import path from "node:path";
import type {
  CreateStructuredModificationPlanInput,
  PlannedChange,
  PlannedChangeKind,
  StructuredModificationPlan,
  StructuredModificationPlanFile
} from "./types.js";

const changeKinds = new Set<PlannedChangeKind>(["create", "modify", "delete", "rename", "signature"]);

function normalizePlanPath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function assertWorkspaceRelativePath(filePath: string) {
  const normalized = normalizePlanPath(filePath);

  if (!normalized || path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`修改计划包含非法工作区路径: ${filePath}`);
  }

  return normalized;
}

function normalizePlanFile(file: StructuredModificationPlanFile): StructuredModificationPlanFile {
  const reason = file.reason.trim();
  const responsibility = file.responsibility?.trim();
  const symbolName = file.symbolName?.trim();

  if (!changeKinds.has(file.changeKind)) throw new Error(`修改计划包含不支持的变更类型: ${String(file.changeKind)}`);
  if (!reason) throw new Error("修改计划中的每个文件都必须说明修改原因");

  return {
    filePath: assertWorkspaceRelativePath(file.filePath),
    changeKind: file.changeKind,
    ...(symbolName ? { symbolName } : {}),
    reason,
    ...(responsibility ? { responsibility } : {})
  };
}

/** 创建补丁前的结构化修改计划，并拒绝重复、冲突或无法审计的文件声明。 */
export function createStructuredModificationPlan(input: CreateStructuredModificationPlanInput): StructuredModificationPlan {
  const taskDescription = input.taskDescription.trim();
  const files = input.files.map(normalizePlanFile);

  if (!taskDescription) throw new Error("修改计划必须包含任务说明");
  if (!files.length) throw new Error("修改计划至少需要包含一个文件");

  const seen = new Set<string>();
  for (const file of files) {
    const key = file.filePath.toLowerCase();
    if (seen.has(key)) throw new Error(`修改计划包含重复文件: ${file.filePath}`);
    seen.add(key);
  }

  return {
    id: input.id?.trim() || `modification-plan-${Date.now().toString(36)}`,
    taskDescription,
    files,
    createdAt: input.createdAt ?? Date.now()
  };
}

/**
 * 校验计划路径与当前工作区状态。create 必须尚不存在，其余操作必须指向现有文件。
 * 这一步发生在补丁生成前，避免模型根据候选补丁反向扩大安全范围。
 */
export async function validateStructuredModificationPlan(workspaceRoot: string, plan: StructuredModificationPlan) {
  const validated = createStructuredModificationPlan(plan);

  for (const file of validated.files) {
    const absolutePath = path.resolve(workspaceRoot, file.filePath);
    const relativePath = path.relative(workspaceRoot, absolutePath);
    if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`修改计划路径越出工作区: ${file.filePath}`);
    }

    const stat = await fs.stat(absolutePath).catch(() => null);
    const existsAsFile = Boolean(stat?.isFile());
    if (file.changeKind === "create" && stat) {
      throw new Error(`create 目标已经存在: ${file.filePath}`);
    }
    if (file.changeKind !== "create" && !existsAsFile) {
      throw new Error(`${file.changeKind} 目标必须是已存在文件: ${file.filePath}`);
    }
  }

  return validated;
}

/** 校验候选补丁是计划的子集，并核对候选状态与声明状态是否一致。 */
export function validatePatchSubsetOfPlan(
  patches: Array<{ filePath: string; status?: "create" | "modify" | "delete" }>,
  plannedChanges: PlannedChange[]
) {
  const planByPath = new Map(plannedChanges.map((change) => [normalizePlanPath(change.filePath).toLowerCase(), change]));
  const blockedFiles: string[] = [];

  for (const patch of patches) {
    const normalizedPath = normalizePlanPath(patch.filePath);
    const planned = planByPath.get(normalizedPath.toLowerCase());
    const patchStatus = patch.status || "modify";
    const expectedStatus = planned?.changeKind === "create" ? "create" : planned?.changeKind === "delete" ? "delete" : "modify";
    if (!planned || patchStatus !== expectedStatus) blockedFiles.push(normalizedPath);
  }

  return { ok: blockedFiles.length === 0, blockedFiles: [...new Set(blockedFiles)] };
}

/** 历史会话读取时复用同一套校验；损坏的旧数据由调用方安全降级为空。 */
export function normalizeStructuredModificationPlan(value: unknown): StructuredModificationPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<StructuredModificationPlan>;
  if (!Array.isArray(record.files)) return null;

  try {
    const files = record.files.map((file) => {
      if (!file || typeof file !== "object") throw new Error("invalid file");
      const candidate = file as Partial<StructuredModificationPlanFile>;
      if (typeof candidate.filePath !== "string" || typeof candidate.reason !== "string" || !candidate.changeKind || !changeKinds.has(candidate.changeKind)) {
        throw new Error("invalid file");
      }
      return candidate as StructuredModificationPlanFile;
    });
    return createStructuredModificationPlan({
      id: typeof record.id === "string" ? record.id : undefined,
      taskDescription: typeof record.taskDescription === "string" ? record.taskDescription : "",
      files,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : undefined
    });
  } catch {
    return null;
  }
}
