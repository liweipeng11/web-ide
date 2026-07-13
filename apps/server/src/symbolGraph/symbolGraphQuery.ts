import type { ModuleDependency, SymbolDefinition, SymbolGraph, SymbolGraphQuery, SymbolGraphQueryResult, SymbolReference, SymbolRelation } from "./types.js";

const DEFAULT_MAX_DEPTH = 4;
const MAX_DEPTH = 10;
const MAX_RESULTS = 300;

function matchesFile(candidate: string, filePath?: string) {
  return !filePath || candidate === filePath || candidate.endsWith(`/${filePath}`);
}

function selectDefinitions(graph: SymbolGraph, query: SymbolGraphQuery) {
  return graph.symbols.filter((symbol) => (!query.symbolName || symbol.name === query.symbolName) && matchesFile(symbol.filePath, query.filePath));
}

function definitionsById(graph: SymbolGraph) {
  return new Map(graph.symbols.map((symbol) => [symbol.id, symbol]));
}

function collectRelations(graph: SymbolGraph, seeds: SymbolDefinition[], referenceKind: "call" | "type", query: SymbolGraphQuery) {
  const symbolMap = definitionsById(graph);
  const direction = query.direction || "both";
  const maxDepth = Math.min(Math.max(query.maxDepth || DEFAULT_MAX_DEPTH, 1), MAX_DEPTH);
  const relations: SymbolRelation[] = [];
  const queue = seeds.map((symbol) => ({ id: symbol.id, depth: 0 }));
  const visited = new Set(queue.map((item) => item.id));
  const incomingByTarget = new Map<string, SymbolReference[]>();
  const outgoingBySource = new Map<string, SymbolReference[]>();
  for (const reference of graph.references) {
    if (reference.kind !== referenceKind) continue;
    if (reference.targetSymbolId) incomingByTarget.set(reference.targetSymbolId, [...(incomingByTarget.get(reference.targetSymbolId) || []), reference]);
    if (reference.sourceSymbolId) outgoingBySource.set(reference.sourceSymbolId, [...(outgoingBySource.get(reference.sourceSymbolId) || []), reference]);
  }

  while (queue.length && relations.length < MAX_RESULTS) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    const incoming = incomingByTarget.get(current.id) || [];
    const outgoing = outgoingBySource.get(current.id) || [];
    const candidates = direction === "incoming" ? incoming : direction === "outgoing" ? outgoing : [...new Set([...incoming, ...outgoing])];

    for (const reference of candidates) {
      const from = reference.sourceSymbolId ? symbolMap.get(reference.sourceSymbolId) : undefined;
      const to = reference.targetSymbolId ? symbolMap.get(reference.targetSymbolId) : undefined;
      relations.push({ depth: current.depth + 1, from, to, reference });
      const nextId = reference.targetSymbolId === current.id ? reference.sourceSymbolId : reference.targetSymbolId;
      if (nextId && !visited.has(nextId)) {
        visited.add(nextId);
        queue.push({ id: nextId, depth: current.depth + 1 });
      }
      if (relations.length >= MAX_RESULTS) break;
    }
  }
  return relations;
}

function collectReverseDependencies(graph: SymbolGraph, definitions: SymbolDefinition[], query: SymbolGraphQuery) {
  const seedFiles = definitions.length ? definitions.map((definition) => definition.filePath) : query.filePath ? [query.filePath] : [];
  const maxDepth = Math.min(Math.max(query.maxDepth || DEFAULT_MAX_DEPTH, 1), MAX_DEPTH);
  const dependencies: ModuleDependency[] = [];
  let frontier = new Set(seedFiles);
  const visited = new Set(seedFiles);
  const dependenciesByTarget = new Map<string, ModuleDependency[]>();
  for (const dependency of graph.dependencies) {
    if (dependency.toFile) dependenciesByTarget.set(dependency.toFile, [...(dependenciesByTarget.get(dependency.toFile) || []), dependency]);
  }

  for (let depth = 0; depth < maxDepth && frontier.size && dependencies.length < MAX_RESULTS; depth += 1) {
    const next = new Set<string>();
    for (const targetFile of frontier) {
      for (const dependency of dependenciesByTarget.get(targetFile) || []) {
        dependencies.push(dependency);
        if (!visited.has(dependency.fromFile)) {
          visited.add(dependency.fromFile);
          next.add(dependency.fromFile);
        }
      }
    }
    frontier = next;
  }
  return dependencies;
}

/** 根据统一查询协议执行定义、引用、依赖、调用链和类型传播分析。 */
export function querySymbolGraph(graph: SymbolGraph, query: SymbolGraphQuery): SymbolGraphQueryResult {
  if ((query.kind === "definition" || query.kind === "references" || query.kind === "callChain" || query.kind === "typePropagation") && !query.symbolName) {
    throw new Error(`${query.kind} query requires symbolName`);
  }
  if (query.kind === "reverseDependencies" && !query.symbolName && !query.filePath) throw new Error("reverseDependencies query requires symbolName or filePath");

  const definitions = selectDefinitions(graph, query);
  let references: SymbolReference[] = [];
  let dependencies: ModuleDependency[] = [];
  let relations: SymbolRelation[] = [];

  if (query.kind === "references") {
    const ids = new Set(definitions.map((definition) => definition.id));
    references = graph.references.filter((reference) => reference.targetSymbolId && ids.has(reference.targetSymbolId));
  } else if (query.kind === "reverseDependencies") {
    dependencies = collectReverseDependencies(graph, definitions, query);
  } else if (query.kind === "callChain") {
    relations = collectRelations(graph, definitions, "call", query);
  } else if (query.kind === "typePropagation") {
    relations = collectRelations(graph, definitions, "type", query);
  }

  return {
    query,
    definitions: definitions.slice(0, MAX_RESULTS),
    references: references.slice(0, MAX_RESULTS),
    dependencies: dependencies.slice(0, MAX_RESULTS),
    relations: relations.slice(0, MAX_RESULTS),
    ambiguous: definitions.length > 1,
    truncated: graph.indexTruncated || definitions.length > MAX_RESULTS || references.length > MAX_RESULTS || dependencies.length > MAX_RESULTS || relations.length >= MAX_RESULTS,
    indexedFileCount: graph.files.length,
    indexedSymbolCount: graph.symbols.length,
    unresolvedReferenceCount: graph.unresolvedReferenceCount,
    indexTruncated: graph.indexTruncated
  };
}
