import type { SymbolDefinition, SymbolGraph } from "../symbolGraph/index.js";
import type { ImpactReason, TraversalImpact, TraversalSeed } from "./types.js";

const DEFAULT_MAX_DEPTH = 4;
const MAX_DEPTH = 10;
const DEFAULT_MAX_FILES = 300;
const MAX_FILES = 1_000;

function addImpact(impacts: Map<string, TraversalImpact>, maxFiles: number, filePath: string, depth: number, reason: ImpactReason, symbolId?: string) {
  const current = impacts.get(filePath);
  if (!current) {
    // 达到上限后不再加入新文件，但调用方仍会继续扫描，以判断是否真的存在溢出结果。
    if (impacts.size >= maxFiles) return "overflow" as const;
    impacts.set(filePath, { filePath, depth, reasons: [reason], affectedSymbolIds: new Set(symbolId ? [symbolId] : []) });
    return "added" as const;
  }

  current.depth = Math.min(current.depth, depth);
  if (!current.reasons.some((item) => JSON.stringify(item) === JSON.stringify(reason))) current.reasons.push(reason);
  if (symbolId) current.affectedSymbolIds.add(symbolId);
  return "updated" as const;
}

/**
 * 从变更目标向反方向遍历符号引用和模块依赖，得到真正依赖目标的调用方与上游模块。
 */
export function traverseReverseImpact(graph: SymbolGraph, seeds: TraversalSeed[], options: { maxDepth?: number; maxFiles?: number } = {}) {
  const maxDepth = Math.min(Math.max(options.maxDepth || DEFAULT_MAX_DEPTH, 1), MAX_DEPTH);
  const maxFiles = Math.min(Math.max(options.maxFiles || DEFAULT_MAX_FILES, 1), MAX_FILES);
  const seedFiles = new Set(seeds.map((seed) => seed.filePath));
  const symbolMap = new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
  const referencesByTarget = new Map<string, typeof graph.references>();
  const dependenciesByTarget = new Map<string, typeof graph.dependencies>();
  const impacts = new Map<string, TraversalImpact>();
  let truncated = false;

  for (const reference of graph.references) {
    if (reference.targetSymbolId) referencesByTarget.set(reference.targetSymbolId, [...(referencesByTarget.get(reference.targetSymbolId) || []), reference]);
  }
  for (const dependency of graph.dependencies) {
    if (dependency.toFile) dependenciesByTarget.set(dependency.toFile, [...(dependenciesByTarget.get(dependency.toFile) || []), dependency]);
  }

  const symbolQueue = seeds.flatMap((seed) => seed.symbols.map((symbol) => ({ symbol, depth: 0 })));
  const visitedSymbols = new Set(symbolQueue.map((item) => item.symbol.id));
  while (symbolQueue.length) {
    const current = symbolQueue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const reference of referencesByTarget.get(current.symbol.id) || []) {
      if (seedFiles.has(reference.filePath)) continue;
      const sourceSymbol = reference.sourceSymbolId ? symbolMap.get(reference.sourceSymbolId) : undefined;
      const addResult = addImpact(impacts, maxFiles, reference.filePath, current.depth + 1, {
        kind: "symbol_reference",
        sourceFile: reference.filePath,
        targetFile: current.symbol.filePath,
        symbolName: current.symbol.name,
        referenceKind: reference.kind
      }, sourceSymbol?.id);
      if (addResult === "overflow") truncated = true;
      // 继续沿调用方符号向上传播，覆盖 controller -> route 等多层调用链。
      if (addResult !== "overflow" && sourceSymbol && !visitedSymbols.has(sourceSymbol.id)) {
        visitedSymbols.add(sourceSymbol.id);
        symbolQueue.push({ symbol: sourceSymbol, depth: current.depth + 1 });
      }
    }
  }

  // 文件级目标从自身开始；符号级目标从真实引用文件开始，避免把同模块的不相关消费者误判为直接影响。
  let frontier = new Map<string, number>();
  for (const seed of seeds) if (!seed.symbols.length) frontier.set(seed.filePath, 0);
  for (const impact of impacts.values()) frontier.set(impact.filePath, impact.depth);
  const expandedFiles = new Set<string>();
  while (frontier.size) {
    const next = new Map<string, number>();
    for (const [targetFile, depth] of frontier) {
      if (depth >= maxDepth || expandedFiles.has(targetFile)) continue;
      expandedFiles.add(targetFile);
      for (const dependency of dependenciesByTarget.get(targetFile) || []) {
        if (seedFiles.has(dependency.fromFile)) continue;
        const nextDepth = depth + 1;
        const addResult = addImpact(impacts, maxFiles, dependency.fromFile, nextDepth, {
          kind: "module_dependency",
          sourceFile: dependency.fromFile,
          targetFile,
        });
        if (addResult === "overflow") {
          truncated = true;
          continue;
        }
        const knownDepth = next.get(dependency.fromFile);
        if (knownDepth === undefined || nextDepth < knownDepth) next.set(dependency.fromFile, nextDepth);
      }
    }
    frontier = next;
  }

  return { impacts: [...impacts.values()], truncated };
}
