import { readWorkspaceFileRange } from "../fileTools.js";
import { languageServiceGateway } from "../languageService/index.js";
import type { InlineEditRequest } from "../contracts/inlineEdit.js";

function locationKey(location: { filePath: string; line: number; column: number }) {
  return `${location.filePath.replace(/\\/g, "/")}:${location.line}:${location.column}`;
}

/** 使用定义与引用补充少量相关代码，避免为 Inline Edit 发送整个长文件。 */
export async function buildInlineEditRelatedContext(request: InlineEditRequest) {
  const location = { filePath: request.filePath, line: request.selection.start.line, column: request.selection.start.column };
  const [definitions, references] = await Promise.all([
    languageServiceGateway.findDefinition(location).catch(() => []),
    languageServiceGateway.findReferences(location).catch(() => [])
  ]);
  const uniqueLocations = [...definitions, ...references]
    .filter((item, index, items) => items.findIndex((candidate) => locationKey(candidate) === locationKey(item)) === index)
    .slice(0, 6);
  const snippets = await Promise.all(uniqueLocations.map(async (item) => {
    const chunk = await readWorkspaceFileRange(item.filePath, Math.max(1, item.line - 4), item.line + 4).catch(() => null);
    if (!chunk?.content) return null;
    return `## ${item.filePath}:${item.line}:${item.column}\n${chunk.content}`;
  }));
  return snippets.filter((item): item is string => Boolean(item)).join("\n\n").slice(0, 12_000) || null;
}
