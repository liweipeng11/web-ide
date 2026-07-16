import crypto from "node:crypto";
import type { ContextArtifact, ContextArtifactKind } from "../contracts/context.js";
import type { ModelMessage, ModelToolCall } from "../contracts/model.js";
import type { TokenEstimator } from "./tokenEstimator.js";

type ToolDescriptor = Pick<ModelToolCall, "name" | "arguments">;

export type ArtifactNormalizationResult = {
  messages: ModelMessage[];
  artifacts: ContextArtifact[];
  truncatedArtifactCount: number;
  includedFileCount: number;
};

function parseJson(value: string | null | undefined): unknown {
  if (!value) return value ?? "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getKind(toolName: string): ContextArtifactKind {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("web") || normalized.includes("browser")) return "web";
  if (normalized.includes("diagnostic") || normalized.includes("valid")) return "diagnostic";
  if (normalized.includes("command") || normalized.includes("run")) return "command";
  if (normalized.includes("search") || normalized.includes("find")) return "search";
  if (normalized.includes("readfile") || normalized.includes("file")) return "file";
  return "summary";
}

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "string" && String(record[key]).trim()) return String(record[key]);
  }
  return "unknown";
}

function getSource(tool: ToolDescriptor | undefined) {
  const args = (tool?.arguments ?? {}) as Record<string, unknown>;
  return firstString(args, ["filePath", "path", "query", "command", "url", "source", "reference"]);
}

function truncateString(value: string, limit: number, tailOnly = false) {
  if (value.length <= limit) return { value, truncated: false };
  if (tailOnly) return { value: `[已省略 ${value.length - limit} 个字符]\n${value.slice(-limit)}`, truncated: true };
  const half = Math.floor(limit / 2);
  return { value: `${value.slice(0, half)}\n[已省略 ${value.length - limit} 个字符]\n${value.slice(-half)}`, truncated: true };
}

function compactContent(kind: ContextArtifactKind, content: unknown) {
  if (kind === "command" && content && typeof content === "object" && !Array.isArray(content)) {
    const record = content as Record<string, unknown>;
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : typeof record.code === "number" ? record.code : null;
    const output = [record.stderr, record.error, record.stdout, record.output].filter((value) => typeof value === "string").join("\n");
    const failed = exitCode !== null ? exitCode !== 0 : Boolean(record.error);
    const compacted = truncateString(output, failed ? 4_000 : 2_500, !failed);
    return {
      content: { exitCode, status: failed ? "failed" : "success", output: compacted.value },
      truncated: compacted.truncated
    };
  }

  const limit = kind === "file" ? 8_000 : kind === "command" ? 4_000 : 5_000;
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  const failed = kind === "command" && /"(?:exitCode|code)"\s*:\s*[1-9]|"error"\s*:|\berror\b/i.test(raw);
  const compacted = truncateString(raw, limit, kind === "command" && !failed);
  return { content: parseJson(compacted.value), truncated: compacted.truncated };
}

function buildToolMap(messages: ModelMessage[]) {
  const result = new Map<string, ToolDescriptor>();
  messages.forEach((message) => message.toolCalls?.forEach((call) => result.set(call.id, call)));
  return result;
}

/** 将 Provider 无关的 tool 消息统一包装为可裁剪、可恢复的 ContextArtifact。 */
export function normalizeToolArtifacts(messages: ModelMessage[], estimator: TokenEstimator): ArtifactNormalizationResult {
  const toolMap = buildToolMap(messages);
  const signatures = new Map<string, string>();
  const artifacts: ContextArtifact[] = [];
  const includedFiles = new Set<string>();
  let truncatedArtifactCount = 0;

  const normalizedMessages = messages.map((message) => {
    if (message.role !== "tool") return message;
    const tool = message.toolCallId ? toolMap.get(message.toolCallId) : undefined;
    const kind = getKind(tool?.name ?? "unknown");
    const source = getSource(tool);
    const original = parseJson(message.content);
    const compacted = compactContent(kind, original);
    const signature = crypto.createHash("sha256").update(`${kind}:${source}:${JSON.stringify(original)}`).digest("hex");
    const existingId = signatures.get(signature);
    const id = `artifact-${signature.slice(0, 16)}`;
    const recoverableReference = `tool-call:${message.toolCallId ?? id}`;
    const artifactContent = kind === "web" ? { untrusted: true, value: compacted.content } : compacted.content;
    const artifact: ContextArtifact = existingId
      ? { id, kind, source, priority: 4, estimatedTokens: 0, content: { reusedArtifactId: existingId }, truncated: true, recoverableReference }
      : { id, kind, source, priority: kind === "diagnostic" ? 1 : 2, estimatedTokens: estimator.estimateValue(artifactContent), content: artifactContent, truncated: compacted.truncated, recoverableReference };

    signatures.set(signature, id);
    artifacts.push(artifact);
    if (kind === "file" && source !== "unknown") includedFiles.add(source);
    if (artifact.truncated) truncatedArtifactCount += 1;
    return { ...message, content: JSON.stringify(artifact) };
  });

  return { messages: normalizedMessages, artifacts, truncatedArtifactCount, includedFileCount: includedFiles.size };
}
