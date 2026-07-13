import { inferRequiredCompanionFiles } from "./companionRules.js";
import type { CandidateFileRecord, ContextSelectionInput, ContextSelectionSnapshot, EvidenceRecord, MissingRequirementRecord, PatchCompletenessReport } from "./types.js";

function normalizeFilePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function unique(values: string[]) {
  return [...new Set(values.map(normalizeFilePath).filter(Boolean))];
}

function mergeCandidate(existing: CandidateFileRecord | undefined, next: CandidateFileRecord): CandidateFileRecord {
  if (!existing) return next;

  return {
    ...existing,
    role: existing.role === "target" || next.role !== "target" ? existing.role : next.role,
    score: Math.max(existing.score, next.score),
    reasons: unique([...existing.reasons, ...next.reasons]),
    read: existing.read || next.read,
    fromTools: [...new Set([...existing.fromTools, ...next.fromTools])]
  };
}

function buildEvidence(input: ContextSelectionInput): EvidenceRecord[] {
  const evidence: EvidenceRecord[] = [];

  if (input.selectedFilePath) {
    evidence.push({
      filePath: normalizeFilePath(input.selectedFilePath),
      evidenceType: "selected_file",
      sourceTool: "selectedFile",
      detail: "用户或调用方提供了当前选中文件，可作为本轮补丁的直接上下文。",
      score: 80
    });
  }

  for (const filePath of unique(input.filesRead || [])) {
    evidence.push({
      filePath,
      evidenceType: "session_history",
      sourceTool: "readFile",
      detail: "任务会话中已经读取过该文件，可作为生成 patch 前的上下文证据。",
      score: 70
    });
  }

  for (const filePath of unique(input.searchResultFiles || [])) {
    evidence.push({
      filePath,
      evidenceType: "text_match",
      sourceTool: "searchCode",
      detail: "搜索结果命中过该文件，但仍需读取后才能作为可编辑依据。",
      score: 40
    });
  }

  for (const filePath of unique(input.previousFailureFiles || [])) {
    evidence.push({
      filePath,
      evidenceType: "previous_failure",
      sourceTool: "validation",
      detail: "最近失败信息涉及该文件，二次修复前应纳入上下文检查。",
      score: 65
    });
  }

  return evidence;
}

function buildCandidates(input: ContextSelectionInput, evidence: EvidenceRecord[]): CandidateFileRecord[] {
  const readFileSet = new Set(unique(input.filesRead || []).map((filePath) => filePath.toLowerCase()));
  const selectedFilePath = input.selectedFilePath ? normalizeFilePath(input.selectedFilePath) : null;
  const candidatesByPath = new Map<string, CandidateFileRecord>();

  for (const item of evidence) {
    const filePath = normalizeFilePath(item.filePath);
    const role = selectedFilePath && filePath.toLowerCase() === selectedFilePath.toLowerCase() ? "target" : item.evidenceType === "previous_failure" ? "context" : "context";
    const candidate = mergeCandidate(candidatesByPath.get(filePath), {
      filePath,
      role,
      score: item.score,
      reasons: [item.detail],
      read: readFileSet.has(filePath.toLowerCase()) || item.evidenceType === "selected_file",
      fromTools: [item.sourceTool === "selectedFile" ? "selectedFile" : item.sourceTool === "validation" ? "taskSession" : item.sourceTool === "searchCode" ? "searchCode" : "readFile"]
    });

    candidatesByPath.set(filePath, candidate);
  }

  return [...candidatesByPath.values()].sort((left, right) => right.score - left.score);
}

function buildMissingRequirements(input: ContextSelectionInput, candidates: CandidateFileRecord[], companions: ReturnType<typeof inferRequiredCompanionFiles>): MissingRequirementRecord[] {
  const missing: MissingRequirementRecord[] = [];
  const hasReadFile = candidates.some((candidate) => candidate.read);
  const hasSearchOnlyContext = Boolean(input.searchResultFiles?.length) && !hasReadFile;

  if (!hasReadFile) {
    missing.push({
      requirement: "read-core-file",
      reason: hasSearchOnlyContext ? "当前只有搜索命中，还没有读取任何核心文件，不能直接生成最终 patch。" : "生成 patch 前至少需要读取一个目标文件或相关上下文文件。",
      severity: "blocking",
      relatedFiles: unique([...(input.searchResultFiles || []), ...(input.previousFailureFiles || [])])
    });
  }

  const unreadCompanions = companions.filter((companion) => companion.status !== "read");

  if (unreadCompanions.length) {
    missing.push({
      requirement: "read-required-companions",
      reason: "本次修改疑似涉及类型、API、props、路由或验证失败链路，关键伴随文件尚未补读或定位。",
      severity: "blocking",
      relatedFiles: unreadCompanions.map((companion) => companion.filePath)
    });
  }

  return missing;
}

function buildSummary(snapshot: Pick<ContextSelectionSnapshot, "candidateFiles" | "requiredCompanions" | "missingRequirements" | "readyForPatch">) {
  if (snapshot.readyForPatch) {
    return `上下文已满足 patch 生成要求：已确认 ${snapshot.candidateFiles.length} 个候选文件，伴随检查 ${snapshot.requiredCompanions.length} 项。`;
  }

  return `上下文不足，暂不进入最终 patch：${snapshot.missingRequirements.map((item) => item.reason).join("；")}`;
}

export function createContextSelectionSnapshot(input: ContextSelectionInput): ContextSelectionSnapshot {
  const normalizedInput: ContextSelectionInput = {
    ...input,
    selectedFilePath: input.selectedFilePath ? normalizeFilePath(input.selectedFilePath) : null,
    filesRead: unique(input.filesRead || []),
    searchResultFiles: unique(input.searchResultFiles || []),
    previousFailureFiles: unique(input.previousFailureFiles || [])
  };
  const evidence = buildEvidence(normalizedInput);
  const candidateFiles = buildCandidates(normalizedInput, evidence);
  const requiredCompanions = inferRequiredCompanionFiles(normalizedInput, evidence);
  const missingRequirements = buildMissingRequirements(normalizedInput, candidateFiles, requiredCompanions);
  const readyForPatch = !missingRequirements.some((item) => item.severity === "blocking");
  const snapshot: ContextSelectionSnapshot = {
    taskSessionId: normalizedInput.taskSessionId ?? null,
    userGoal: normalizedInput.userGoal,
    candidateFiles,
    evidence,
    requiredCompanions,
    missingRequirements,
    readyForPatch,
    summary: "",
    createdAt: Date.now()
  };

  return {
    ...snapshot,
    summary: buildSummary(snapshot)
  };
}

export function buildPatchCompletenessReport(input: { snapshot: ContextSelectionSnapshot; patchFiles: string[] }): PatchCompletenessReport {
  const patchFileSet = new Set(input.patchFiles.map((filePath) => normalizeFilePath(filePath).toLowerCase()));
  const risks: MissingRequirementRecord[] = [];
  const targetFiles = input.snapshot.candidateFiles.filter((candidate) => candidate.role === "target");
  const missedTargets = targetFiles.filter((candidate) => !patchFileSet.has(candidate.filePath.toLowerCase()));
  const unreadCompanions = input.snapshot.requiredCompanions.filter((companion) => companion.status !== "read");

  if (missedTargets.length) {
    risks.push({
      requirement: "patch-cover-target-files",
      reason: "patch 未覆盖上下文快照中的核心目标文件，可能遗漏用户明确选中的修改对象。",
      severity: "warning",
      relatedFiles: missedTargets.map((candidate) => candidate.filePath)
    });
  }

  if (unreadCompanions.length) {
    risks.push({
      requirement: "patch-after-unread-companions",
      reason: "patch 生成结束时仍存在未读取或未定位的伴随文件，链路型改动可能不完整。",
      severity: "warning",
      relatedFiles: unreadCompanions.map((companion) => companion.filePath)
    });
  }

  return {
    ready: !risks.some((risk) => risk.severity === "blocking"),
    risks,
    checkedFiles: input.patchFiles.map(normalizeFilePath),
    createdAt: Date.now()
  };
}

export function formatContextSelectionNeed(snapshot: ContextSelectionSnapshot) {
  const relatedFiles = unique(snapshot.missingRequirements.flatMap((item) => item.relatedFiles));
  const nextSearchKeywords = relatedFiles.filter((filePath) => filePath.startsWith("待定位:")).map((filePath) => filePath.replace(/^待定位:/, ""));
  const concreteFiles = relatedFiles.filter((filePath) => !filePath.startsWith("待定位:"));

  return {
    message: `${snapshot.summary}${concreteFiles.length ? ` 建议先读取：${concreteFiles.join(", ")}。` : ""}${nextSearchKeywords.length ? ` 建议继续搜索：${nextSearchKeywords.join(", ")}。` : ""}`,
    relatedFiles,
    nextSearchKeywords
  };
}
