import { analyzeProject } from "../projectAnalyzer.js";
import type { ValidationCommandCandidate } from "../projectAnalyzerTypes.js";
import type { VerificationCommand, VerificationStage } from "./types.js";

const stagePriority: Record<VerificationStage, number> = {
  format_syntax: 0,
  typecheck: 1,
  lint: 2,
  test: 3,
  build: 4
};

/** 根据脚本名和实际命令判断验证职责，避免依赖单一命名约定。 */
export function classifyVerificationStage(candidate: Pick<ValidationCommandCandidate, "name" | "command">): VerificationStage {
  const value = `${candidate.name} ${candidate.command}`.toLowerCase();

  if (/\b(?:typecheck|type-check|mypy|tsc)\b/.test(value)) return "typecheck";
  if (/\b(?:lint|eslint|ruff)\b/.test(value)) return "lint";
  if (/\b(?:test|vitest|jest|pytest)\b/.test(value)) return "test";
  if (/\b(?:build|vite\s+build|webpack)\b/.test(value)) return "build";
  return "format_syntax";
}

/** 去重并按固定验证阶段排序，保证低成本错误优先暴露。 */
export function orderVerificationCommands(candidates: ValidationCommandCandidate[]): VerificationCommand[] {
  const seen = new Set<string>();

  return candidates
    .filter((candidate) => {
      const key = candidate.command.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate, index) => ({ ...candidate, stage: classifyVerificationStage(candidate), index }))
    .sort((left, right) => stagePriority[left.stage] - stagePriority[right.stage] || left.index - right.index)
    .map(({ index: _index, ...candidate }) => candidate);
}

/** 使用项目扫描结果生成完整验证计划，并将调用方建议命令合并到对应阶段。 */
export async function planVerificationCommands(workspaceRoot: string, preferredCommand?: string | null) {
  const analysis = await analyzeProject(workspaceRoot);
  const command = preferredCommand?.trim();
  const requestedCandidates: ValidationCommandCandidate[] = command
    ? [{ name: command, command, source: "request", reason: "调用方指定的验证命令" }]
    : [];

  return orderVerificationCommands([...analysis.validationCommands, ...requestedCandidates]);
}
