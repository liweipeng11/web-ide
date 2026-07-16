import fs from "node:fs/promises";
import path from "node:path";
import type { HoverInfo, SourceLocation, UnifiedSymbol } from "../contracts/languageService.js";
import { buildSymbolGraph, querySymbolGraph, type SymbolDefinition } from "../symbolGraph/index.js";
import { normalizeRelativePath } from "./pathUtils.js";

function symbolKind(kind: SymbolDefinition["kind"]): UnifiedSymbol["kind"] {
  if (kind === "component") return "class";
  return kind;
}

export async function wordAtLocation(workspaceRoot: string, location: SourceLocation) {
  const filePath = normalizeRelativePath(workspaceRoot, location.filePath);
  const content = await fs.readFile(path.resolve(workspaceRoot, filePath), "utf8");
  const line = content.split(/\r?\n/)[Math.max(0, location.line - 1)] ?? "";
  const index = Math.max(0, location.column - 1);
  const isWord = (value: string | undefined) => Boolean(value && /[\w$]/.test(value));
  let start = index;
  let end = index;
  while (start > 0 && isWord(line[start - 1])) start -= 1;
  while (end < line.length && isWord(line[end])) end += 1;
  return line.slice(start, end);
}

function definitionLocation(definition: SymbolDefinition): SourceLocation {
  return { filePath: definition.filePath, line: definition.line, column: definition.column, source: "symbol_graph", complete: false };
}

/** 将现有 TS/JS/Vue Symbol Graph 归一为语言服务协议，并明确标记结果不完整。 */
export class SymbolGraphLanguageAdapter {
  async findDefinition(workspaceRoot: string, location: SourceLocation) {
    const name = await wordAtLocation(workspaceRoot, location);
    if (!name) return [];
    const graph = await buildSymbolGraph(workspaceRoot);
    return querySymbolGraph(graph, { kind: "definition", symbolName: name }).definitions.map(definitionLocation);
  }

  async findReferences(workspaceRoot: string, location: SourceLocation) {
    const name = await wordAtLocation(workspaceRoot, location);
    if (!name) return [];
    const graph = await buildSymbolGraph(workspaceRoot);
    return querySymbolGraph(graph, { kind: "references", symbolName: name }).references.map((reference) => ({
      filePath: reference.filePath,
      line: reference.line,
      column: reference.column,
      source: "symbol_graph" as const,
      complete: false
    }));
  }

  async listWorkspaceSymbols(workspaceRoot: string, query: string): Promise<UnifiedSymbol[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const graph = await buildSymbolGraph(workspaceRoot);
    return graph.symbols
      .filter((symbol) => !normalizedQuery || symbol.name.toLowerCase().includes(normalizedQuery))
      .slice(0, 200)
      .map((symbol) => ({ name: symbol.name, kind: symbolKind(symbol.kind), containerName: symbol.containerName, location: definitionLocation(symbol), source: "symbol_graph" }));
  }

  async getHover(workspaceRoot: string, location: SourceLocation): Promise<HoverInfo | null> {
    const name = await wordAtLocation(workspaceRoot, location);
    if (!name) return null;
    const graph = await buildSymbolGraph(workspaceRoot);
    const definitions = querySymbolGraph(graph, { kind: "definition", symbolName: name }).definitions;
    if (!definitions.length) return null;
    const first = definitions[0];
    return { contents: `${first.kind} ${first.name}\n\n定义于 ${first.filePath}:${first.line}:${first.column}`, source: "symbol_graph" };
  }
}
