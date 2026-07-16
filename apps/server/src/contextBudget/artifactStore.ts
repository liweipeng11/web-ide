import fs from "node:fs/promises";
import path from "node:path";
import { projectRuntimeDirectory } from "../statePaths.js";

type StoredContextArtifact = {
  version: 1;
  taskSessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result: unknown;
  createdAt: number;
};

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function artifactDirectory(taskSessionId: string) {
  return path.join(projectRuntimeDirectory("context-artifacts"), safeSegment(taskSessionId));
}

function artifactPath(taskSessionId: string, toolCallId: string) {
  return path.join(artifactDirectory(taskSessionId), `${safeSegment(toolCallId)}.json`);
}

/** 原始工具结果独立存储，不再重复发送给模型，但可按引用分块恢复。 */
export async function storeContextArtifact(input: Omit<StoredContextArtifact, "version" | "createdAt">) {
  const artifact: StoredContextArtifact = { version: 1, ...input, createdAt: Date.now() };
  await fs.mkdir(artifactDirectory(input.taskSessionId), { recursive: true });
  await fs.writeFile(artifactPath(input.taskSessionId, input.toolCallId), `${JSON.stringify(artifact)}\n`, "utf8");
}

export async function recoverStoredContextArtifact(input: { taskSessionId: string; reference: string; offset?: number; maxChars?: number }) {
  const match = /^tool-call:([a-zA-Z0-9._:-]+)$/.exec(input.reference.trim());
  if (!match) throw new Error("reference must use the tool-call:<id> format");
  const toolCallId = match[1];
  const stored = await fs.readFile(artifactPath(input.taskSessionId, toolCallId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error("Context artifact not found or expired");
    throw error;
  });
  const artifact = JSON.parse(stored) as StoredContextArtifact;
  const serialized = JSON.stringify(artifact.result);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const maxChars = Math.min(4_000, Math.max(200, Math.floor(input.maxChars ?? 4_000)));
  const content = serialized.slice(offset, offset + maxChars);

  return {
    reference: input.reference,
    toolName: artifact.toolName,
    arguments: artifact.arguments,
    offset,
    nextOffset: offset + content.length,
    totalChars: serialized.length,
    hasMore: offset + content.length < serialized.length,
    content
  };
}

export async function deleteStoredContextArtifacts(taskSessionId: string) {
  await fs.rm(artifactDirectory(taskSessionId), { recursive: true, force: true });
}
