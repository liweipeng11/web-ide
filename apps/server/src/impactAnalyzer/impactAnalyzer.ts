import path from "node:path";
import { buildSymbolGraph, type SymbolGraph } from "../symbolGraph/index.js";
import { assessImpactRisk, attachImpactMetadata } from "./impactClassifier.js";
import { traverseReverseImpact } from "./impactTraversal.js";
import type { ImpactAnalysisOptions, ImpactAnalysisResult, ImpactChangeTarget, ImpactTargetResolution, TraversalSeed } from "./types.js";

function normalizeFilePath(filePath: string) {
  if (!filePath.trim() || path.isAbsolute(filePath)) throw new Error("Impact Analyzer filePath must be workspace-relative");
  const normalized = path.posix.normalize(filePath.trim().replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("Impact Analyzer filePath is outside workspace");
  }
  return normalized;
}

function countRelevantUnresolvedReferences(graph: SymbolGraph, seeds: TraversalSeed[]) {
  const changedSymbolNames = new Set(seeds.flatMap((seed) => seed.symbols.map((symbol) => symbol.name)));
  if (!changedSymbolNames.size) return 0;
  // 未解析引用只有与变更符号同名时才可能是漏掉的消费者，避免全局索引噪声污染单次完整性结论。
  return graph.references.filter((reference) => !reference.targetSymbolId && changedSymbolNames.has(reference.name)).length;
}

function resolveTargets(graph: SymbolGraph, targets: ImpactChangeTarget[]): { changes: ImpactTargetResolution[]; seeds: TraversalSeed[] } {
  const changes: ImpactTargetResolution[] = [];
  const seeds: TraversalSeed[] = [];
  for (const target of targets) {
    const filePath = normalizeFilePath(target.filePath);
    const fileExists = graph.files.includes(filePath);
    const definitions = target.symbolName ? graph.symbols.filter((symbol) => symbol.filePath === filePath && symbol.name === target.symbolName) : [];
    const status: ImpactTargetResolution["status"] = !fileExists || (target.symbolName && !definitions.length) ? "missing" : definitions.length > 1 ? "ambiguous" : "resolved";
    const change: ImpactTargetResolution = { ...target, filePath, changeKind: target.changeKind || "modify", status, definitions };
    changes.push(change);
    if (status === "resolved") seeds.push({ filePath, symbols: definitions });
  }
  return { changes, seeds };
}

/**
 * 分析拟变更文件或符号的上游影响范围；结果是静态分析证据，不替代实际测试和类型检查。
 */
export async function analyzeImpact(workspaceRoot: string, targets: ImpactChangeTarget[], options: ImpactAnalysisOptions = {}): Promise<ImpactAnalysisResult> {
  if (!targets.length) throw new Error("Impact Analyzer requires at least one change target");
  const graph = await buildSymbolGraph(workspaceRoot);
  const { changes, seeds } = resolveTargets(graph, targets);
  const traversal = traverseReverseImpact(graph, seeds, options);
  const impactedFiles = attachImpactMetadata(traversal.impacts, graph.symbols);
  const unresolvedReferenceCount = countRelevantUnresolvedReferences(graph, seeds);
  const diagnostics: string[] = [];
  for (const change of changes) {
    if (change.status === "missing") diagnostics.push(`未找到变更目标：${change.filePath}${change.symbolName ? `#${change.symbolName}` : ""}`);
    if (change.status === "ambiguous") diagnostics.push(`变更目标存在多个定义：${change.filePath}#${change.symbolName}`);
  }
  if (graph.indexTruncated) diagnostics.push("符号图索引已截断，实际影响范围可能更大");
  if (unresolvedReferenceCount) diagnostics.push(`本次影响链存在 ${unresolvedReferenceCount} 个未解析引用，静态传播可能不完整`);
  if (traversal.truncated) diagnostics.push("影响文件数量达到上限，结果已截断");

  const relatedTests = impactedFiles.filter((file) => file.categories.includes("test")).map((file) => file.filePath);
  const boundaryFiles = impactedFiles.filter((file) => file.categories.some((category) => ["route", "entrypoint", "configuration", "type_contract"].includes(category))).map((file) => file.filePath);
  const risk = assessImpactRisk(changes, impactedFiles, diagnostics);
  return {
    changes,
    impactedFiles,
    relatedTests,
    boundaryFiles,
    risk,
    diagnostics,
    complete: diagnostics.length === 0,
    truncated: graph.indexTruncated || traversal.truncated,
    indexedFileCount: graph.files.length,
    indexedSymbolCount: graph.symbols.length,
    unresolvedReferenceCount,
    indexedUnresolvedReferenceCount: graph.unresolvedReferenceCount
  };
}
