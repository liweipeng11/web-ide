import type { Monaco, OnMount } from "@monaco-editor/react";
import type { SourceRange, UnifiedDiagnostic } from "../api";
import type { InlineEditDraft } from "../hooks/useInlineEdit";

type EditorInstance = Parameters<OnMount>[0];

// 从 Monaco 当前模型构建受限上下文，长文件只截取选区前后各 30 行。
export function createInlineEditDraft(input: {
  editor: EditorInstance;
  monaco: Monaco;
  filePath: string;
  languageId: string;
  diagnostics: UnifiedDiagnostic[];
  projectRules?: string | null;
  requestedRange?: SourceRange;
}): InlineEditDraft | null {
  const model = input.editor.getModel();
  if (!model) return null;
  const selection = input.requestedRange
    ? new input.monaco.Range(input.requestedRange.start.line, input.requestedRange.start.column, input.requestedRange.end.line, input.requestedRange.end.column)
    : input.editor.getSelection();
  if (!selection) return null;
  const prefixStartLine = Math.max(1, selection.startLineNumber - 30);
  const suffixEndLine = Math.min(model.getLineCount(), selection.endLineNumber + 30);

  return {
    filePath: input.filePath,
    documentVersion: model.getAlternativeVersionId(),
    documentLineCount: model.getLineCount(),
    selectionStartLineMaxColumn: model.getLineMaxColumn(selection.startLineNumber),
    selectionEndLineMaxColumn: model.getLineMaxColumn(selection.endLineNumber),
    selection: { start: { line: selection.startLineNumber, column: selection.startColumn }, end: { line: selection.endLineNumber, column: selection.endColumn } },
    selectedText: model.getValueInRange(selection),
    prefix: model.getValueInRange(new input.monaco.Range(prefixStartLine, 1, selection.startLineNumber, selection.startColumn)),
    suffix: model.getValueInRange(new input.monaco.Range(selection.endLineNumber, selection.endColumn, suffixEndLine, model.getLineMaxColumn(suffixEndLine))),
    languageId: input.languageId,
    diagnostics: input.diagnostics.map((diagnostic) => ({
      message: diagnostic.message,
      severity: diagnostic.severity === "information" || diagnostic.severity === "hint" ? "info" : diagnostic.severity,
      range: diagnostic.range
    })),
    projectRules: input.projectRules
  };
}
