import { useEffect, useRef, type MutableRefObject } from "react";
import type { Monaco, OnMount } from "@monaco-editor/react";
import type { InlineEditCandidate } from "../api";
import type { InlineEditDraft } from "./useInlineEdit";

type EditorInstance = Parameters<OnMount>[0];

/** 管理 Monaco 临时候选装饰和 View Zone，拒绝或取消时统一清理。 */
export function useInlineEditPreview(options: {
  editorRef: MutableRefObject<EditorInstance | null>;
  monacoRef: MutableRefObject<Monaco | null>;
  draft: InlineEditDraft | null;
  candidate: InlineEditCandidate | null;
  streamedReplacement: string;
}) {
  const decorations = useRef<string[]>([]);
  const viewZone = useRef<string | null>(null);

  useEffect(() => {
    const editor = options.editorRef.current;
    const monaco = options.monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;

    const previewRange = options.candidate?.range ?? options.draft?.selection;
    const previewReplacement = options.candidate?.replacement ?? options.streamedReplacement;
    const hasPreview = Boolean(options.candidate) || options.streamedReplacement.length > 0;
    let originalRange = previewRange ? new monaco.Range(previewRange.start.line, previewRange.start.column, previewRange.end.line, previewRange.end.column) : null;

    if (options.candidate && options.draft && previewRange) {
      const original = options.draft.selectedText;
      const replacement = options.candidate.replacement;
      let prefixLength = 0;
      while (prefixLength < original.length && prefixLength < replacement.length && original[prefixLength] === replacement[prefixLength]) prefixLength += 1;
      let suffixLength = 0;
      while (suffixLength < original.length - prefixLength && suffixLength < replacement.length - prefixLength && original[original.length - 1 - suffixLength] === replacement[replacement.length - 1 - suffixLength]) suffixLength += 1;
      const selectionOffset = model.getOffsetAt({ lineNumber: previewRange.start.line, column: previewRange.start.column });
      const changedStart = model.getPositionAt(selectionOffset + prefixLength);
      const changedEnd = model.getPositionAt(selectionOffset + original.length - suffixLength);
      originalRange = new monaco.Range(changedStart.lineNumber, changedStart.column, changedEnd.lineNumber, changedEnd.column);
    }

    decorations.current = editor.deltaDecorations(decorations.current, originalRange && hasPreview ? [{
      range: originalRange,
      options: { className: "inline-edit-original-range", inlineClassName: "inline-edit-original-text" }
    }] : []);
    editor.changeViewZones((accessor) => {
      if (viewZone.current) accessor.removeZone(viewZone.current);
      viewZone.current = null;
      if (!previewRange || !hasPreview) return;
      const domNode = document.createElement("div");
      domNode.className = "inline-edit-proposed-zone";
      const pre = document.createElement("pre");
      pre.textContent = previewReplacement || "（删除选区）";
      domNode.appendChild(pre);
      viewZone.current = accessor.addZone({
        afterLineNumber: previewRange.end.line,
        heightInLines: Math.min(12, Math.max(1, previewReplacement.split(/\r?\n/).length)),
        domNode
      });
    });

    return () => {
      decorations.current = editor.deltaDecorations(decorations.current, []);
      editor.changeViewZones((accessor) => {
        if (viewZone.current) accessor.removeZone(viewZone.current);
        viewZone.current = null;
      });
    };
  }, [options.candidate, options.draft, options.streamedReplacement]);
}
