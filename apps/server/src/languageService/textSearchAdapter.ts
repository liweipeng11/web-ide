import type { SourceLocation } from "../contracts/languageService.js";
import { searchWorkspaceCode } from "../codeDiscovery/index.js";
import { wordAtLocation } from "./symbolGraphAdapter.js";

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** LSP 与 Symbol Graph 都不可用时提供保守文本定位，并明确标记结果不完整。 */
export class TextSearchLanguageAdapter {
  async findReferences(workspaceRoot: string, location: SourceLocation): Promise<SourceLocation[]> {
    const word = await wordAtLocation(workspaceRoot, location);
    if (!word) return [];
    const matches = await searchWorkspaceCode(word, { caseSensitive: true, limit: 200 });
    return matches
      .filter((match) => new RegExp(`\\b${escapeRegex(word)}\\b`).test(match.match))
      .map((match) => ({ filePath: match.filePath, line: match.line, column: match.column, source: "text_search", complete: false }));
  }

  async findDefinition(workspaceRoot: string, location: SourceLocation): Promise<SourceLocation[]> {
    const word = await wordAtLocation(workspaceRoot, location);
    if (!word) return [];
    const candidates = await this.findReferences(workspaceRoot, location);
    const matches = await searchWorkspaceCode(word, { caseSensitive: true, limit: 200 });
    const definitionPattern = new RegExp(`\\b(?:class|interface|type|enum|function|def|const|let|var)\\s+${escapeRegex(word)}\\b|\\b${escapeRegex(word)}\\s*=`);
    const definingKeys = new Set(matches.filter((match) => definitionPattern.test(match.content)).map((match) => `${match.filePath}:${match.line}:${match.column}`));
    return candidates.filter((candidate) => definingKeys.has(`${candidate.filePath}:${candidate.line}:${candidate.column}`));
  }
}
