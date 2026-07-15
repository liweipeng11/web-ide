import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectRuntimeDirectory } from "../statePaths.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import type { ReasoningAudit } from "./types.js";

function auditFilePath(runId: string) {
  const fileName = `${createHash("sha256").update(runId).digest("hex")}.json`;
  return path.join(projectRuntimeDirectory("external-context"), "reasoning", fileName);
}

export function getReasoningAuditDisplayPath(runId: string) {
  const absolutePath = auditFilePath(runId);
  const workspaceRoot = getWorkspaceRoot();
  return workspaceRoot ? path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/") : absolutePath;
}

export async function readReasoningAudit(runId: string): Promise<ReasoningAudit | null> {
  try {
    const content = await fs.readFile(auditFilePath(runId), "utf8");
    const value = JSON.parse(content) as ReasoningAudit;
    if (value.schemaVersion !== 1 || value.runId !== runId || !value.branches || typeof value.branches !== "object") throw new Error("Reasoning audit file has an invalid structure");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 使用临时文件替换，避免进程中断留下半份推理审计 JSON。 */
export async function writeReasoningAudit(audit: ReasoningAudit) {
  const filePath = auditFilePath(audit.runId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
  await fs.rename(temporaryPath, filePath);
  return getReasoningAuditDisplayPath(audit.runId);
}

export async function deleteReasoningAudit(runId: string) {
  await fs.rm(auditFilePath(runId), { force: true });
}
