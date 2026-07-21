import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { mutateProjectMemory } from "./projectMemoryService.js";
import type { PromoteMemoryInput, ProjectMemoryItem } from "./types.js";

const RULES_DIRECTORY = path.join(".mini-ai", "rules");
const MAX_RULE_FILE_LENGTH = 120;

function requireWorkspaceRoot(workspaceRoot = getWorkspaceRoot()) {
  if (!workspaceRoot) throw new HttpError(400, "Open a workspace before promoting memory");
  return workspaceRoot;
}

function normalizeRuleFile(value: unknown) {
  if (typeof value !== "string") throw new HttpError(400, "ruleFile must be a markdown file name");
  const file = value.trim().toLowerCase();
  if (!file || file.length > MAX_RULE_FILE_LENGTH || !/^[a-z0-9][a-z0-9._-]*\.md$/.test(file)) {
    throw new HttpError(400, "ruleFile must be a safe .md file name");
  }
  return file;
}

function normalizePaths(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new HttpError(400, "paths must be an array of strings");
  return [...new Set(value.map((item) => item.trim().replace(/\\/g, "/").replace(/^\/+/, "")).filter(Boolean))].slice(0, 30);
}

export function normalizePromotionInput(value: unknown): PromoteMemoryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Promotion input must be an object");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["ruleFile", "scope", "paths", "alwaysApply", "confirmed"]);
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported) throw new HttpError(400, `Field ${unsupported} cannot be set by the client`);
  const scope = record.scope === "path" ? "path" : record.scope === "project" ? "project" : null;
  if (!scope) throw new HttpError(400, "scope must be project or path");
  const paths = normalizePaths(record.paths ?? []);
  if (scope === "path" && !paths.length) throw new HttpError(400, "Path-scoped rules require at least one path glob");
  if (typeof record.alwaysApply !== "boolean") throw new HttpError(400, "alwaysApply must be a boolean");
  if (record.confirmed !== true) throw new HttpError(400, "Promotion requires explicit confirmation");
  return { ruleFile: normalizeRuleFile(record.ruleFile), scope, paths: scope === "path" ? paths : [], alwaysApply: record.alwaysApply, confirmed: true };
}

function buildRuleContent(item: ProjectMemoryItem, input: PromoteMemoryInput) {
  const globs = input.scope === "path" ? input.paths : [];
  return [
    "---",
    `alwaysApply: ${String(input.alwaysApply)}`,
    `globs: [${globs.map((glob) => JSON.stringify(glob)).join(", ")}]`,
    "---",
    "",
    `<!-- 由 Project Memory ${item.id} 提升；原始来源保留在管理界面。 -->`,
    item.content.trim(),
    ""
  ].join("\n");
}

/** 规则文件与 Memory 审计标记作为一个业务操作处理，回写失败时删除新文件。 */
export async function promoteMemoryToRule(id: string, input: PromoteMemoryInput, workspaceRoot?: string) {
  const root = requireWorkspaceRoot(workspaceRoot);
  let promotedItem: ProjectMemoryItem | null = null;
  const memory = await mutateProjectMemory((current) => {
    const item = current.items.find((entry) => entry.id === id);
    if (!item) throw new HttpError(404, "Memory item not found");
    if (item.status !== "active") throw new HttpError(409, "Only active memory can be promoted to a rule");
    if (item.promotedTo) throw new HttpError(409, `Memory item was already promoted to ${item.promotedTo.rulePath}`);
    promotedItem = item;
    return current;
  }, root);
  void memory;
  if (!promotedItem) throw new Error("Failed to load memory item for promotion");

  const rulePath = path.posix.join(".mini-ai/rules", input.ruleFile);
  const absolutePath = path.join(root, RULES_DIRECTORY, input.ruleFile);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, buildRuleContent(promotedItem, input), { encoding: "utf8", flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new HttpError(409, `Rule file ${rulePath} already exists`);
    throw error;
  });

  try {
    const saved = await mutateProjectMemory((current) => {
      const latest = current.items.find((item) => item.id === id);
      if (!latest || latest.status !== "active") throw new HttpError(409, "Memory item changed while it was being promoted");
      if (latest.promotedTo) throw new HttpError(409, `Memory item was already promoted to ${latest.promotedTo.rulePath}`);
      return {
        ...current,
        items: current.items.map((item) => item.id === id ? {
          ...item,
          promotedTo: { rulePath, scope: input.scope, paths: input.paths, alwaysApply: input.alwaysApply, promotedAt: Date.now() },
          updatedAt: Date.now()
        } : item)
      };
    }, root);
    const item = saved.items.find((entry) => entry.id === id);
    if (!item) throw new Error("Promoted memory item disappeared");
    return { item, rulePath };
  } catch (error) {
    await fs.unlink(absolutePath).catch(() => undefined);
    throw error;
  }
}
