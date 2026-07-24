import { diffLines } from "diff";
import { resolveSafeEditEvidence } from "./evidence.js";
import type { SafeEditCandidate, SafeEditFileAssessment, SafeEditRecommendation, SafeEditRisk } from "./types.js";

const REFACTOR_PATTERN = /(?:\brefactor(?:ing)?\b|\bcleanup\b|\bclean up\b|重构|清理|整理)/i;
const FORMAT_PATTERN = /(?:\bformat(?:ting)?\b|\bprettier\b|格式化|排版)/i;
const RENAME_PATTERN = /(?:\brename\b|\brenamed\b|重命名|改名)/i;
const TEST_REQUEST_PATTERN = /(?:\btests?\b|\bspecs?\b|测试|用例|覆盖率)/i;
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/|tests?\/|test_[^/]+)|(?:\.test|\.spec)\.[^/]+$/i;

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function isNearRecommendedFile(filePath: string, recommendation: SafeEditRecommendation) {
  const candidateDirectory = normalizePath(filePath).split("/").slice(0, -1).join("/");
  return [...recommendation.requiredFiles, ...recommendation.conditionalFiles].some((recommendedPath) => {
    const recommendedDirectory = normalizePath(recommendedPath).split("/").slice(0, -1).join("/");
    return Boolean(candidateDirectory) && candidateDirectory === recommendedDirectory;
  });
}

function getLineChanges(oldContent: string, newContent: string) {
  let addedLines = 0;
  let removedLines = 0;
  let addedText = "";
  let removedText = "";

  for (const part of diffLines(oldContent, newContent)) {
    const lineCount = part.count || 0;
    if (part.added) {
      addedLines += lineCount;
      addedText += part.value;
    }
    if (part.removed) {
      removedLines += lineCount;
      removedText += part.value;
    }
  }

  return { addedLines, removedLines, addedText, removedText };
}

function countIdentifiers(value: string) {
  const counts = new Map<string, number>();
  for (const identifier of value.match(/[A-Za-z_$][\w$]*/g) || []) counts.set(identifier, (counts.get(identifier) || 0) + 1);
  return counts;
}

function detectsBulkIdentifierRename(removedText: string, addedText: string) {
  const removed = countIdentifiers(removedText);
  const added = countIdentifiers(addedText);
  const removedCandidates = [...removed].filter(([name, count]) => count >= 3 && !added.has(name));
  const addedCandidates = [...added].filter(([name, count]) => count >= 3 && !removed.has(name));
  return removedCandidates.some(([, removedCount]) => addedCandidates.some(([, addedCount]) => removedCount === addedCount));
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, "").trim();
}

function classifyRole(candidate: SafeEditCandidate, recommendation: SafeEditRecommendation, taskDescription: string) {
  const filePath = normalizePath(candidate.filePath);
  const evidence = resolveSafeEditEvidence(recommendation);
  const hasReliableScope = evidence.sources.length > 0 && evidence.complete;
  const requiredFiles = new Set(recommendation.requiredFiles.map(normalizePath));
  const conditionalFiles = new Set(recommendation.conditionalFiles.map(normalizePath));
  const validationFiles = new Set(recommendation.validationFiles.map(normalizePath));
  if (requiredFiles.has(filePath)) return { role: "required" as const, reason: "属于影响分析中的明确变更目标" };
  if (conditionalFiles.has(filePath)) return { role: "supporting" as const, reason: "属于破坏性变更的直接消费者，可能需要配套调整" };
  // 证据缺失或不完整时不能断言候选文件已经超出范围。
  if (!hasReliableScope) return { role: "unverified" as const, reason: "当前证据不足，尚不能确认该文件是否属于最小修改集合" };
  if (validationFiles.has(filePath) && TEST_REQUEST_PATTERN.test(taskDescription) && TEST_FILE_PATTERN.test(filePath)) {
    return { role: "supporting" as const, reason: "用户明确要求测试改动，该测试文件属于配套修改" };
  }
  if (validationFiles.has(filePath)) return { role: "validation_only" as const, reason: "位于影响链中，默认只需验证而非直接修改" };
  if (candidate.status === "create" && isNearRecommendedFile(candidate.filePath, recommendation)) return { role: "supporting" as const, reason: "新增文件与明确变更目标位于同一职责目录" };
  return { role: "expansion" as const, reason: "不在最小修改集合或已知影响链中" };
}

/** 对单个候选 diff 进行启发式分类；这里只标记风险，不替代人工 diff 审阅。 */
export function classifySafeEditCandidate(candidate: SafeEditCandidate, recommendation: SafeEditRecommendation, taskDescription: string): SafeEditFileAssessment {
  const classification = classifyRole(candidate, recommendation, taskDescription);
  const evidence = resolveSafeEditEvidence(recommendation);
  const { addedLines, removedLines, addedText, removedText } = getLineChanges(candidate.oldContent, candidate.newContent);
  const risks: SafeEditRisk[] = [];
  const summary = candidate.summary || "";

  if (!evidence.sources.length) {
    risks.push({ kind: "missing_impact_analysis", level: "high", filePath: candidate.filePath, message: "本轮没有明确目标或影响分析证据，无法证明该文件属于最小修改集合。" });
  }
  if (evidence.sources.length && !evidence.complete) {
    const detail = evidence.diagnostics.length ? `：${evidence.diagnostics.join("；")}` : "";
    risks.push({ kind: "incomplete_impact_analysis", level: "high", filePath: candidate.filePath, message: `影响分析不完整，不能确认最小修改范围${detail}` });
  }

  if (classification.role === "expansion") risks.push({ kind: "scope_expansion", level: "high", filePath: candidate.filePath, message: "候选文件超出影响分析建议的最小修改集合。" });
  if (classification.role === "validation_only") risks.push({ kind: "scope_expansion", level: "medium", filePath: candidate.filePath, message: "该文件来自影响链，默认应通过测试或检查验证；直接修改需要额外理由。" });
  if (REFACTOR_PATTERN.test(summary) && !REFACTOR_PATTERN.test(taskDescription)) risks.push({ kind: "opportunistic_refactor", level: "medium", filePath: candidate.filePath, message: "文件摘要包含用户未要求的重构或清理意图。" });

  const whitespaceOnly = candidate.oldContent !== candidate.newContent && normalizeWhitespace(candidate.oldContent) === normalizeWhitespace(candidate.newContent);
  if ((whitespaceOnly || FORMAT_PATTERN.test(summary)) && !FORMAT_PATTERN.test(taskDescription)) risks.push({ kind: "formatting_only", level: "medium", filePath: candidate.filePath, message: "变更主要是用户未要求的格式调整。" });

  const oldLineCount = Math.max(1, candidate.oldContent.split(/\r?\n/).length);
  if (oldLineCount >= 80 && (addedLines + removedLines) / oldLineCount >= 0.6) risks.push({ kind: "broad_rewrite", level: "medium", filePath: candidate.filePath, message: "候选 diff 改写了文件中的大范围内容，应确认是否能缩小为局部编辑。" });
  if ((RENAME_PATTERN.test(summary) || detectsBulkIdentifierRename(removedText, addedText)) && !RENAME_PATTERN.test(taskDescription)) risks.push({ kind: "bulk_rename", level: "medium", filePath: candidate.filePath, message: "diff 中包含用户未要求的批量标识符重命名。" });

  return { filePath: candidate.filePath, role: classification.role, reasons: [classification.reason], addedLines, removedLines, risks };
}
