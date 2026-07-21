import { HttpError } from "../errors.js";
import type { ProjectMemoryKind, ProjectMemoryScope, ProjectMemorySourceRef } from "./types.js";

export const MEMORY_CONTENT_MAX_LENGTH = 2_000;
export const MEMORY_SOURCE_REF_MAX_LENGTH = 500;
export const MEMORY_SOURCE_REF_MAX_ITEMS = 20;
export const MEMORY_SCOPE_PATH_MAX_ITEMS = 30;

const validKinds = new Set<ProjectMemoryKind>(["convention", "decision", "fact", "risk"]);
const validSourceTypes = new Set<ProjectMemorySourceRef["type"]>(["schema_migration", "task", "user", "file"]);

const sensitivePatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: "api_key", pattern: /\b(?:sk|pk|rk)-(?:live-|test-)?[a-z0-9_-]{16,}\b/i },
  { name: "github_token", pattern: /\bgh[pousr]_[a-z0-9]{20,}\b/i },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "bearer_token", pattern: /\bBearer\s+[a-z0-9._~+/=-]{20,}/i },
  { name: "database_url", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@]+:[^\s@]+@/i },
  { name: "secret_assignment", pattern: /\b(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|CLIENT_SECRET|DATABASE_URL|PASSWORD|PRIVATE_KEY)\s*=\s*[^\s]{6,}/i },
  { name: "jwt", pattern: /\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/ },
  { name: "email", pattern: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i },
  { name: "cn_phone", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ }
];

/** 统一候选文本，消除不可见字符和无意义空白带来的重复项。 */
export function normalizeMemoryContent(value: unknown) {
  if (typeof value !== "string") throw new HttpError(400, "Memory content must be a string");
  const content = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!content) throw new HttpError(400, "Memory content cannot be empty");
  if (content.length > MEMORY_CONTENT_MAX_LENGTH) {
    throw new HttpError(400, `Memory content cannot exceed ${MEMORY_CONTENT_MAX_LENGTH} characters`);
  }
  return content;
}

export function findSensitiveMemoryReason(content: string) {
  return sensitivePatterns.find(({ pattern }) => pattern.test(content))?.name ?? null;
}

/** 敏感值只返回类别，不把原文复制进错误或日志。 */
export function ensureMemoryContentIsSafe(content: string) {
  const reason = findSensitiveMemoryReason(content);
  if (reason) throw new HttpError(400, `Memory content contains sensitive information (${reason})`);
}

export function normalizeMemoryKind(value: unknown): ProjectMemoryKind {
  if (!validKinds.has(value as ProjectMemoryKind)) throw new HttpError(400, "Memory kind is invalid");
  return value as ProjectMemoryKind;
}

export function normalizeMemoryScope(value: unknown): ProjectMemoryScope {
  if (value === undefined) return { type: "project", paths: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Memory scope must be an object");
  const record = value as Record<string, unknown>;
  if (record.type !== "project" && record.type !== "path") throw new HttpError(400, "Memory scope type is invalid");
  if (!Array.isArray(record.paths) || !record.paths.every((item) => typeof item === "string")) {
    throw new HttpError(400, "Memory scope paths must be an array of strings");
  }
  if (record.paths.length > MEMORY_SCOPE_PATH_MAX_ITEMS) throw new HttpError(400, "Memory scope contains too many paths");
  const paths = [...new Set(record.paths.map((item) => item.trim().replace(/\\/g, "/")).filter(Boolean))];
  if (paths.some((item) => item.length > MEMORY_SOURCE_REF_MAX_LENGTH)) throw new HttpError(400, "Memory scope path is too long");
  if (record.type === "project") {
    if (paths.length) throw new HttpError(400, "Project scope cannot contain paths");
    return { type: "project", paths: [] };
  }
  if (!paths.length) throw new HttpError(400, "Path scope requires at least one path");
  return { type: "path", paths };
}

export function normalizeMemorySourceRefs(value: unknown): ProjectMemorySourceRef[] {
  if (!Array.isArray(value)) throw new HttpError(400, "Memory sourceRefs must be an array");
  if (value.length > MEMORY_SOURCE_REF_MAX_ITEMS) throw new HttpError(400, "Memory contains too many source references");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400, "Memory source reference is invalid");
    const record = item as Record<string, unknown>;
    if (!validSourceTypes.has(record.type as ProjectMemorySourceRef["type"])) throw new HttpError(400, "Memory source type is invalid");
    if (typeof record.value !== "string" || !record.value.trim()) throw new HttpError(400, "Memory source value is required");
    const sourceValue = record.value.trim();
    if (sourceValue.length > MEMORY_SOURCE_REF_MAX_LENGTH) throw new HttpError(400, "Memory source value is too long");
    if (findSensitiveMemoryReason(sourceValue)) throw new HttpError(400, "Memory source value contains sensitive information");
    return { type: record.type as ProjectMemorySourceRef["type"], value: sourceValue };
  });
}

export function normalizeMemoryConfidence(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(400, "Memory confidence must be a number between 0 and 1");
  }
  return value;
}
