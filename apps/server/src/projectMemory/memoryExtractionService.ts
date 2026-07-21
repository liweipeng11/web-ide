import { createMemoryCandidate } from "./memoryCandidateService.js";
import {
  normalizeMemoryConfidence,
  normalizeMemoryContent,
  normalizeMemoryKind,
  normalizeMemorySourceRefs
} from "./memorySanitizer.js";
import type { MemoryExtractionResult, ProjectMemoryItem, ProjectMemorySourceRef } from "./types.js";
import { isProjectMemoryFeatureEnabled } from "./projectMemoryFeatureFlags.js";

const MAX_EXTRACTED_CANDIDATES = 20;

function asRecord(value: unknown, message: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function ensureExactKeys(record: Record<string, unknown>, keys: string[], message: string) {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) throw new Error(message);
}

/** 模型输出必须完整通过运行时校验，不能依赖 TypeScript 类型断言。 */
export function parseMemoryExtractionResult(value: unknown): MemoryExtractionResult {
  const record = asRecord(value, "Memory extraction result must be an object");
  ensureExactKeys(record, ["candidates"], "Memory extraction result contains unsupported fields");
  if (!Array.isArray(record.candidates)) throw new Error("Memory extraction candidates must be an array");
  if (record.candidates.length > MAX_EXTRACTED_CANDIDATES) throw new Error("Memory extraction returned too many candidates");

  return {
    candidates: record.candidates.map((value) => {
      const candidate = asRecord(value, "Extracted memory candidate must be an object");
      ensureExactKeys(candidate, ["kind", "content", "confidence", "sourceRefs"], "Extracted memory candidate contains unsupported fields");
      return {
        kind: normalizeMemoryKind(candidate.kind),
        content: normalizeMemoryContent(candidate.content),
        confidence: normalizeMemoryConfidence(candidate.confidence),
        sourceRefs: normalizeMemorySourceRefs(candidate.sourceRefs)
      };
    })
  };
}

function sourceKey(sourceRef: ProjectMemorySourceRef) {
  return `${sourceRef.type}:${sourceRef.value}`;
}

export type StoreMemoryExtractionResult = {
  candidates: ProjectMemoryItem[];
  duplicateCount: number;
  rejectedCount: number;
  error?: string;
};

/** 抽取失败采用降级返回；调用方可继续完成主任务，且错误中不携带模型原文。 */
export async function storeMemoryExtractionResult(
  value: unknown,
  trustedSourceRefs: ProjectMemorySourceRef[],
  workspaceRoot?: string
): Promise<StoreMemoryExtractionResult> {
  if (!isProjectMemoryFeatureEnabled("autoExtractionEnabled")) {
    return { candidates: [], duplicateCount: 0, rejectedCount: 0, error: "Project Memory auto extraction is disabled" };
  }
  try {
    const parsed = parseMemoryExtractionResult(value);
    const trusted = new Set(normalizeMemorySourceRefs(trustedSourceRefs).map(sourceKey));
    const candidates: ProjectMemoryItem[] = [];
    let duplicateCount = 0;
    let rejectedCount = 0;

    for (const candidate of parsed.candidates) {
      // 模型只能引用调用方提供的真实来源，避免自行声明用户确认或任务证据。
      if (!candidate.sourceRefs.length || candidate.sourceRefs.some((sourceRef) => !trusted.has(sourceKey(sourceRef)))) {
        rejectedCount += 1;
        continue;
      }
      try {
        const result = await createMemoryCandidate({ ...candidate, scope: { type: "project", paths: [] }, createdBy: "system" }, workspaceRoot);
        candidates.push(result.candidate);
        if (!result.created) duplicateCount += 1;
      } catch {
        // 单条候选包含敏感信息或非法内容时，只丢弃该条，不影响同批其他候选。
        rejectedCount += 1;
      }
    }
    return { candidates, duplicateCount, rejectedCount };
  } catch {
    return { candidates: [], duplicateCount: 0, rejectedCount: 0, error: "Memory extraction result validation failed" };
  }
}
