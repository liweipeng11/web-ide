import { HttpError } from "../errors.js";
import type { InlineEditCandidate, InlineEditRequest, InlineEditResult, TextPosition, TextRange } from "../contracts/inlineEdit.js";

const maxInstructionChars = 4_000;
const maxContextChars = 24_000;
const maxReplacementChars = 80_000;

type ModelInlineEditResponse =
  | { mode?: "inline"; filePath?: unknown; baseVersion?: unknown; range?: unknown; replacement?: unknown; explanation?: unknown }
  | { mode: "patch_review"; reason?: unknown };

export type InlineEditGenerator = (prompt: string, onDelta: (delta: string) => void, signal?: AbortSignal) => Promise<string>;

function isPosition(value: unknown): value is TextPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const position = value as Partial<TextPosition>;
  return Number.isInteger(position.line) && Number.isInteger(position.column) && (position.line ?? 0) >= 1 && (position.column ?? 0) >= 1;
}

function isRange(value: unknown): value is TextRange {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Partial<TextRange>;
  return isPosition(range.start) && isPosition(range.end);
}

function sameRange(left: TextRange, right: TextRange) {
  return left.start.line === right.start.line && left.start.column === right.start.column && left.end.line === right.end.line && left.end.column === right.end.column;
}

function isOrderedRange(range: TextRange) {
  return range.start.line < range.end.line || (range.start.line === range.end.line && range.start.column <= range.end.column);
}

function decodeJsonStringPrefix(source: string) {
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === '"') break;
    if (char !== "\\") {
      result += char;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const code = source.slice(index + 2, index + 6);
      if (!/^[0-9a-f]{4}$/i.test(code)) break;
      result += String.fromCharCode(Number.parseInt(code, 16));
      index += 5;
      continue;
    }
    const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
    result += escapes[escaped] ?? escaped;
    index += 1;
  }
  return result;
}

export function extractReplacementPreview(content: string) {
  const match = /"replacement"\s*:\s*"/.exec(content);
  if (!match) return "";
  return decodeJsonStringPrefix(content.slice(match.index + match[0].length));
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function parseModelJson(content: string): ModelInlineEditResponse {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
  const source = fenced ?? trimmed;

  try {
    return JSON.parse(source) as ModelInlineEditResponse;
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(source.slice(start, end + 1)) as ModelInlineEditResponse;
      } catch {
        // 继续抛出统一错误，避免把 Provider 原始响应直接暴露给前端。
      }
    }
    throw new HttpError(502, "模型未返回有效的 Inline Edit 结构化结果，请重新生成");
  }
}

function validateRequest(request: InlineEditRequest) {
  if (!request.filePath?.trim()) throw new HttpError(400, "filePath is required");
  if (!Number.isInteger(request.documentVersion) || request.documentVersion < 1) throw new HttpError(400, "documentVersion must be a positive integer");
  if (!isRange(request.selection)) throw new HttpError(400, "selection is invalid");
  if (!Number.isInteger(request.documentLineCount) || request.documentLineCount < 1) throw new HttpError(400, "documentLineCount must be a positive integer");
  if (!Number.isInteger(request.selectionStartLineMaxColumn) || request.selectionStartLineMaxColumn < 1 || !Number.isInteger(request.selectionEndLineMaxColumn) || request.selectionEndLineMaxColumn < 1) {
    throw new HttpError(400, "selection line boundaries are invalid");
  }
  if (!isOrderedRange(request.selection)
    || request.selection.start.line > request.documentLineCount
    || request.selection.end.line > request.documentLineCount
    || request.selection.start.column > request.selectionStartLineMaxColumn
    || request.selection.end.column > request.selectionEndLineMaxColumn) {
    throw new HttpError(422, "selection is outside the document range");
  }
  if (typeof request.selectedText !== "string" || typeof request.prefix !== "string" || typeof request.suffix !== "string") throw new HttpError(400, "selection context is invalid");
  if (!request.instruction?.trim()) throw new HttpError(400, "instruction is required");
  if (request.instruction.length > maxInstructionChars) throw new HttpError(400, `instruction cannot exceed ${maxInstructionChars} characters`);
  if (request.selectedText.length + request.prefix.length + request.suffix.length > maxContextChars) throw new HttpError(413, "Inline Edit context is too large");
}

function validateCandidate(request: InlineEditRequest, value: ModelInlineEditResponse): InlineEditResult {
  if (value.mode === "patch_review") {
    const reason = typeof value.reason === "string" && value.reason.trim() ? value.reason.trim().slice(0, 500) : "该修改需要跨文件处理";
    return { mode: "patch_review", reason };
  }

  if (typeof value.filePath !== "string" || normalizePath(value.filePath) !== normalizePath(request.filePath)) {
    return { mode: "patch_review", reason: "模型判断该修改涉及目标文件以外的内容，已升级为 Patch Review" };
  }
  if (value.baseVersion !== request.documentVersion) throw new HttpError(409, "Inline Edit 候选的文档版本已失效，请重新生成");
  if (!isRange(value.range) || !sameRange(value.range, request.selection)) throw new HttpError(422, "模型返回的编辑范围无效或超出原选区");
  if (typeof value.replacement !== "string") throw new HttpError(422, "模型返回的 replacement 无效");
  if (value.replacement.length > maxReplacementChars) throw new HttpError(413, `replacement cannot exceed ${maxReplacementChars} characters`);
  if (value.replacement === request.selectedText) throw new HttpError(422, "模型未生成有效修改，请调整要求后重新生成");

  const candidate: InlineEditCandidate = {
    filePath: request.filePath,
    baseVersion: request.documentVersion,
    range: request.selection,
    replacement: value.replacement,
    explanation: typeof value.explanation === "string" ? value.explanation.trim().slice(0, 1_000) : undefined
  };
  return { mode: "inline", candidate };
}

function buildPrompt(request: InlineEditRequest) {
  const diagnostics = (request.diagnostics ?? []).slice(0, 20).map((item) => `- [${item.severity}] ${item.message}`).join("\n") || "无";
  const rules = request.projectRules?.trim().slice(0, 8_000) || "无额外项目规则";

  // Inline Edit 使用专用 JSON 协议，不允许模型输出文件写入命令或自由文本补丁。
  return [
    "你是代码编辑器的 Inline Edit 生成器。只返回一个 JSON 对象，不要使用 Markdown。",
    "若请求必须修改其他文件，返回 {\"mode\":\"patch_review\",\"reason\":\"原因\"}。",
    "否则只能修改给定选区，返回 {\"mode\":\"inline\",\"filePath\":string,\"baseVersion\":number,\"range\":给定范围,\"replacement\":string,\"explanation\":string}。",
    "replacement 必须是选区的完整替换文本；空选区表示在光标处插入。不要返回任何其他文件路径或写文件指令。",
    `文件：${request.filePath}`,
    `语言：${request.languageId}`,
    `文档版本：${request.documentVersion}`,
    `选区范围：${JSON.stringify(request.selection)}`,
    `用户要求：${request.instruction.trim()}`,
    `项目规则：\n${rules}`,
    `当前诊断：\n${diagnostics}`,
    `相关符号上下文：\n${request.relatedContext?.trim().slice(0, 12_000) || "未发现额外定义或引用上下文"}`,
    `选区前上下文：\n${request.prefix}`,
    `选区内容：\n${request.selectedText}`,
    `选区后上下文：\n${request.suffix}`
  ].join("\n\n");
}

export async function generateInlineEdit(request: InlineEditRequest, generator: InlineEditGenerator, onDelta: (generatedCharacters: number, replacementPreview: string) => void, signal?: AbortSignal) {
  validateRequest(request);
  let generatedCharacters = 0;
  let streamedContent = "";
  const content = await generator(buildPrompt(request), (delta) => {
    generatedCharacters += delta.length;
    streamedContent += delta;
    onDelta(generatedCharacters, extractReplacementPreview(streamedContent));
  }, signal);
  return validateCandidate(request, parseModelJson(content));
}
