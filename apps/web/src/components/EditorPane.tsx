import { useEffect, useRef, useState } from "react";
import Editor, { type Monaco, type OnMount } from "@monaco-editor/react";
import { createLanguageWorkspaceEditPatch, fetchLanguageCodeActions, fetchLanguageHover, findLanguageDefinition, findLanguageReferences, renameLanguageSymbol, searchLanguageWorkspaceSymbols, type GenerateEditResponse, type SourceLocation, type SourceRange, type UnifiedCodeAction, type UnifiedDiagnostic, type UnifiedSymbol } from "../api";
import type { OpenFileTab } from "../appState";
import { useServerCapabilities } from "../capabilities/CapabilitiesProvider";
import { useInlineEdit, type InlineEditChangeContext, type InlineEditUpgradeRequest } from "../hooks/useInlineEdit";
import { useInlineEditPreview } from "../hooks/useInlineEditPreview";
import { useLanguageService } from "../hooks/useLanguageService";
import { createInlineEditDraft } from "../inlineEdit/monacoAdapter";
import Icon from "./Icon";
import InlineEditWidget from "./InlineEditWidget";

type Props = {
  path: string | null;
  tabs: OpenFileTab[];
  value: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onSelectTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onChange: (value: string) => void;
  onNavigate: (location: SourceLocation) => Promise<void>;
  onRequestAgentFix: (diagnostic: UnifiedDiagnostic, codeActionTitle?: string) => void;
  onPendingPatch: (patch: GenerateEditResponse) => void;
  onLanguageServiceError: (message: string) => void;
  projectRules?: string | null;
  onAcceptAndValidate: (content: string, context: InlineEditChangeContext) => Promise<void>;
  onUpgradeInlineEdit: (request: InlineEditUpgradeRequest) => Promise<void>;
};

function getLanguage(path: string | null) {
  if (!path) return "plaintext";
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".py") || path.endsWith(".pyi")) return "python";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".vue") || path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function getFileName(path: string) { return path.split(/[\\/]/).pop() || path; }
function getFileBadge(path: string) { const extension = getFileName(path).split(".").pop(); return extension ? extension.slice(0, 3).toUpperCase() : "TXT"; }
function getPathParts(path: string | null) { return path ? path.split(/[\\/]/).filter(Boolean) : []; }
function severity(monaco: Monaco, value: UnifiedDiagnostic["severity"]) { return value === "error" ? monaco.MarkerSeverity.Error : value === "warning" ? monaco.MarkerSeverity.Warning : value === "hint" ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Info; }
function currentLocation(editor: Parameters<OnMount>[0], path: string): SourceLocation | null { const position = editor.getPosition(); return position ? { filePath: path, line: position.lineNumber, column: position.column } : null; }

export default function EditorPane({ path, tabs, value, dirty, saving, onSave, onSelectTab, onCloseTab, onChange, onNavigate, onRequestAgentFix, onPendingPatch, onLanguageServiceError, projectRules, onAcceptAndValidate, onUpgradeInlineEdit }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const pathRef = useRef(path);
  const navigateRef = useRef(onNavigate);
  const fixRef = useRef(onRequestAgentFix);
  const pendingPatchRef = useRef(onPendingPatch);
  const errorRef = useRef(onLanguageServiceError);
  const providerDisposables = useRef<Array<{ dispose(): void }>>([]);
  const symbolSearchTimer = useRef<number | null>(null);
  const symbolSearchSequence = useRef(0);
  const openInlineEditRef = useRef<(instruction?: string, range?: SourceRange) => void>(() => undefined);
  const acceptInlineEditRef = useRef<() => void>(() => undefined);
  const resetInlineEditRef = useRef<() => void>(() => undefined);
  const acceptAndValidateRef = useRef(onAcceptAndValidate);
  const inlineEnabledRef = useRef(false);
  const lastInlinePath = useRef(path);
  const inlineActiveRef = useRef(false);
  const [symbolQuery, setSymbolQuery] = useState("");
  const [symbols, setSymbols] = useState<UnifiedSymbol[]>([]);
  const [symbolSearchOpen, setSymbolSearchOpen] = useState(false);
  const [symbolPanelMode, setSymbolPanelMode] = useState<"search" | "references">("search");
  const pathParts = getPathParts(path);
  const languageService = useLanguageService({ path, content: value, saved: !dirty });
  const { capabilities } = useServerCapabilities();
  const inlineEditEnabled = capabilities?.features.inlineEdit.active === true;
  const inlineEdit = useInlineEdit({
    onPatchReview: onUpgradeInlineEdit
  });
  pathRef.current = path;
  navigateRef.current = onNavigate;
  fixRef.current = onRequestAgentFix;
  pendingPatchRef.current = onPendingPatch;
  errorRef.current = onLanguageServiceError;
  acceptAndValidateRef.current = onAcceptAndValidate;
  inlineEnabledRef.current = inlineEditEnabled;
  inlineActiveRef.current = Boolean(inlineEdit.draft);
  useInlineEditPreview({ editorRef, monacoRef, draft: inlineEdit.draft, candidate: inlineEdit.candidate, streamedReplacement: inlineEdit.streamedReplacement });

  openInlineEditRef.current = (initialInstruction = "", requestedRange?: SourceRange) => {
    const editor = editorRef.current;
    const currentPath = pathRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco || !currentPath || !inlineEnabledRef.current) return;
    const draft = createInlineEditDraft({ editor, monaco, filePath: currentPath, languageId: getLanguage(currentPath), diagnostics: languageService.diagnostics, projectRules, requestedRange });
    if (draft) inlineEdit.open(draft, initialInstruction);
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;
    monaco.editor.setModelMarkers(model, "language-service", languageService.diagnostics.map((diagnostic) => ({
      startLineNumber: diagnostic.range.start.line,
      startColumn: diagnostic.range.start.column,
      endLineNumber: diagnostic.range.end.line,
      endColumn: diagnostic.range.end.column,
      message: diagnostic.message,
      code: diagnostic.code === undefined ? undefined : String(diagnostic.code),
      source: diagnostic.source,
      severity: severity(monaco, diagnostic.severity)
    })));
  }, [languageService.diagnostics, path]);

  useEffect(() => {
    if (lastInlinePath.current !== path) {
      if (inlineActiveRef.current) onLanguageServiceError("切换文件后已取消未完成的 Inline Edit 候选");
      inlineEdit.reset();
      lastInlinePath.current = path;
    }
  }, [path]);

  useEffect(() => () => {
    providerDisposables.current.forEach((disposable) => disposable.dispose());
    providerDisposables.current = [];
    if (symbolSearchTimer.current !== null) window.clearTimeout(symbolSearchTimer.current);
  }, []);

  async function navigateTo(location: SourceLocation) {
    await navigateRef.current(location);
    window.setTimeout(() => {
      editorRef.current?.setPosition({ lineNumber: location.line, column: location.column });
      editorRef.current?.revealPositionInCenter({ lineNumber: location.line, column: location.column });
      editorRef.current?.focus();
    }, 0);
  }

  async function searchSymbols(query: string) {
    setSymbolPanelMode("search");
    setSymbolQuery(query);
    if (symbolSearchTimer.current !== null) window.clearTimeout(symbolSearchTimer.current);
    const sequence = ++symbolSearchSequence.current;
    symbolSearchTimer.current = window.setTimeout(async () => {
      try {
        const result = await searchLanguageWorkspaceSymbols(query);
        if (sequence === symbolSearchSequence.current) setSymbols(result.symbols);
      } catch {
        if (sequence === symbolSearchSequence.current) setSymbols([]);
      }
    }, 180);
  }

  function acceptInlineEdit(validateAfterAccept = false) {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const candidate = inlineEdit.candidate;
    const acceptedContext = inlineEdit.draft ? { instruction: inlineEdit.instruction, draft: inlineEdit.draft } : null;
    if (!editor || !model || !candidate) return;
    if (pathRef.current !== candidate.filePath || model.getAlternativeVersionId() !== candidate.baseVersion) {
      onLanguageServiceError("文档版本已变化，不能应用旧的 Inline Edit 候选，请重新生成");
      return;
    }
    editor.pushUndoStop();
    editor.executeEdits("inline-edit", [{
      range: new (monacoRef.current!).Range(candidate.range.start.line, candidate.range.start.column, candidate.range.end.line, candidate.range.end.column),
      text: candidate.replacement,
      forceMoveMarkers: true
    }]);
    editor.pushUndoStop();
    inlineEdit.reset();
    editor.focus();
    if (validateAfterAccept && acceptedContext) {
      // 直接传递 Monaco 最新内容，避免等待 React 状态同步时保存到旧版本。
      void acceptAndValidateRef.current(model.getValue(), acceptedContext);
    }
  }

  const inlineConflict = Boolean(inlineEdit.candidate && editorRef.current?.getModel()?.getAlternativeVersionId() !== inlineEdit.candidate.baseVersion);
  acceptInlineEditRef.current = acceptInlineEdit;
  resetInlineEditRef.current = inlineEdit.reset;

  return (
    <section className="editor-pane">
      <div className="editor-tabbar" role="tablist" aria-label="Open files">
        {tabs.length ? tabs.map((tab) => {
          const tabDirty = tab.content !== tab.savedContent;
          const active = tab.path === path;
          return (
            <div key={tab.path} className={active ? "editor-tab active" : "editor-tab"}>
              <button type="button" className="editor-tab-main" role="tab" aria-selected={active} title={tab.path} onClick={() => onSelectTab(tab.path)}>
                <span className="editor-tab-badge">{getFileBadge(tab.path)}</span>
                <span className="editor-tab-name">{getFileName(tab.path)}</span>
                {tabDirty ? <span className="editor-tab-dirty" aria-label="Unsaved changes" /> : null}
              </button>
              <button type="button" className="editor-tab-close" title="Close" aria-label={`Close ${getFileName(tab.path)}`} onClick={() => onCloseTab(tab.path)}><Icon name="close" /></button>
            </div>
          );
        }) : <span className="editor-empty-tab">No file open</span>}
      </div>
      <div className="editor-pathbar">
        <div className="editor-breadcrumb" title={path || ""}>{pathParts.length ? pathParts.map((part, index) => <span className={index === pathParts.length - 1 ? "current" : ""} key={`${part}-${index}`}>{part}</span>) : <span>Select a file</span>}</div>
        <div className="editor-actions">
          <div className="editor-status-group">
            {path && languageService.capability ? <span className={languageService.capability.degraded ? "lsp-state degraded" : "lsp-state"} title={languageService.capability.detail}>{languageService.capability.degraded ? `降级 · ${languageService.capability.source}` : `LSP · ${languageService.capability.languageId}`}</span> : null}
            <span className={`save-state ${saving ? "saving" : dirty ? "dirty" : "saved"}`}>{saving ? "保存中" : dirty ? "未保存" : "已保存"}</span>
          </div>
          <div className="editor-command-group">
            {inlineEditEnabled ? <button type="button" className="inline-edit-trigger" disabled={!path} title="AI 内联编辑（Ctrl/Cmd+I）" onClick={() => openInlineEditRef.current()}>AI 编辑</button> : null}
            <button type="button" className="icon-button" disabled={!path} title="搜索工作区符号" aria-label="搜索工作区符号" onClick={() => { setSymbolPanelMode("search"); setSymbolSearchOpen((open) => !open); if (!symbolSearchOpen) void searchSymbols(""); }}><Icon name="search" /></button>
            <button type="button" className="icon-button" disabled={!path || !dirty || saving} title="保存文件 (Ctrl+S)" aria-label="保存文件" onClick={onSave}><Icon name="save" /></button>
          </div>
        </div>
      </div>
      {symbolSearchOpen ? <div className="workspace-symbol-search">{symbolPanelMode === "search" ? <input autoFocus value={symbolQuery} placeholder="搜索工作区符号" onChange={(event) => void searchSymbols(event.target.value)} /> : <div className="workspace-symbol-heading">引用结果 · {symbols.length} 项</div>}<div className="workspace-symbol-results">{symbols.map((symbol, index) => <button type="button" key={`${symbol.name}:${symbol.location.filePath}:${symbol.location.line}:${index}`} onClick={() => { setSymbolSearchOpen(false); void navigateTo(symbol.location); }}><strong>{symbol.name}</strong><span>{symbol.kind} · {symbol.location.filePath}:{symbol.location.line}</span></button>)}</div></div> : null}
      {inlineEdit.draft ? <InlineEditWidget instruction={inlineEdit.instruction} status={inlineEdit.status} generatedCharacters={inlineEdit.generatedCharacters} streamedReplacement={inlineEdit.streamedReplacement} candidate={inlineEdit.candidate} conflict={inlineConflict} error={inlineEdit.error} onInstructionChange={inlineEdit.setInstruction} onGenerate={() => void inlineEdit.generate()} onAccept={() => acceptInlineEdit(false)} onAcceptAndValidate={() => acceptInlineEdit(true)} onReject={inlineEdit.reset} onStop={inlineEdit.stop} /> : null}
      <div className="editor-host">
        <Editor
          height="100%" language={getLanguage(path)} path={path || "empty.txt"} value={value}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
          monacoRef.current = monaco;
          const inlineHoverNode = document.createElement("button");
          inlineHoverNode.type = "button";
          inlineHoverNode.className = "inline-edit-selection-action";
          inlineHoverNode.textContent = "AI 编辑";
          inlineHoverNode.setAttribute("aria-label", "使用 AI 编辑当前选区");
          inlineHoverNode.onclick = () => openInlineEditRef.current();
          const inlineHoverWidget = {
            getId: () => "inline-edit.selection-action",
            getDomNode: () => inlineHoverNode,
            getPosition: () => {
              const selection = editor.getSelection();
              if (!inlineEnabledRef.current || !selection || selection.isEmpty()) return null;
              return {
                position: { lineNumber: selection.endLineNumber, column: selection.endColumn },
                preference: [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE]
              };
            }
          };
          editor.addContentWidget(inlineHoverWidget);
          const inlineHoverSelectionDisposable = editor.onDidChangeCursorSelection(() => editor.layoutContentWidget(inlineHoverWidget));
          providerDisposables.current.push(inlineHoverSelectionDisposable, { dispose: () => editor.removeContentWidget(inlineHoverWidget) });
          editor.addAction({ id: "inline-edit.open", label: "AI 内联编辑", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI], contextMenuGroupId: "1_modification", contextMenuOrder: 1.5, run: () => openInlineEditRef.current() });
          editor.addAction({ id: "inline-edit.accept", label: "接受 Inline Edit 候选", keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Enter], run: () => acceptInlineEditRef.current() });
          editor.addAction({ id: "inline-edit.reject", label: "拒绝 Inline Edit 候选", keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Escape], run: () => resetInlineEditRef.current() });
          editor.addAction({ id: "language-service.go-to-definition", label: "转到定义（语言服务）", keybindings: [monaco.KeyCode.F12], run: async () => { const currentPath = pathRef.current; if (!currentPath) return; const source = currentLocation(editor, currentPath); if (!source) return; const result = await findLanguageDefinition(source); if (result.result[0]) await navigateTo(result.result[0]); } });
          editor.addAction({ id: "language-service.find-references", label: "查找引用（语言服务）", keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12], run: async () => { const currentPath = pathRef.current; if (!currentPath) return; const source = currentLocation(editor, currentPath); if (!source) return; const result = await findLanguageReferences(source); setSymbols(result.result.map((location, index) => ({ name: `引用 ${index + 1}`, kind: "reference", location, source: location.source ?? "none" }))); setSymbolPanelMode("references"); setSymbolSearchOpen(true); } });
          editor.addAction({ id: "language-service.rename", label: "重命名符号（生成 Patch）", keybindings: [monaco.KeyCode.F2], run: async () => { const currentPath = pathRef.current; if (!currentPath) return; const source = currentLocation(editor, currentPath); if (!source) return; const newName = window.prompt("输入新的符号名称"); if (!newName?.trim()) return; try { pendingPatchRef.current((await renameLanguageSymbol(source, newName.trim())).patch); } catch (error) { errorRef.current(error instanceof Error ? error.message : "重命名失败"); } } });
          providerDisposables.current.push(monaco.languages.registerHoverProvider(["typescript", "javascript", "python", "html"], { provideHover: async (_model, position) => { const currentPath = pathRef.current; if (!currentPath) return null; const response = await fetchLanguageHover({ filePath: currentPath, line: position.lineNumber, column: position.column }).catch(() => null); return response?.result ? { contents: [{ value: response.result.contents }], range: response.result.range ? { startLineNumber: response.result.range.start.line, startColumn: response.result.range.start.column, endLineNumber: response.result.range.end.line, endColumn: response.result.range.end.column } : undefined } : null; } }));
          providerDisposables.current.push(monaco.languages.registerCodeActionProvider(["typescript", "javascript", "python", "html"], { provideCodeActions: async (_model, range, context) => {
            const currentPath = pathRef.current;
            if (!currentPath) return { actions: [], dispose: () => undefined };
            const diagnostics: UnifiedDiagnostic[] = context.markers.map((marker) => ({ filePath: currentPath, range: { start: { line: marker.startLineNumber, column: marker.startColumn }, end: { line: marker.endLineNumber, column: marker.endColumn } }, severity: marker.severity === monaco.MarkerSeverity.Error ? "error" : marker.severity === monaco.MarkerSeverity.Warning ? "warning" : marker.severity === monaco.MarkerSeverity.Hint ? "hint" : "information", message: marker.message, code: typeof marker.code === "string" ? marker.code : marker.code?.value, source: "lsp" }));
            const lspActions = await fetchLanguageCodeActions(currentPath, { start: { line: range.startLineNumber, column: range.startColumn }, end: { line: range.endLineNumber, column: range.endColumn } }, diagnostics).then((result) => result.actions, () => []);
            const actions = lspActions.map((action) => {
              const diagnostic = action.diagnostics[0] ?? diagnostics[0] ?? { filePath: currentPath, range: { start: { line: range.startLineNumber, column: range.startColumn }, end: { line: range.endLineNumber, column: range.endColumn } }, severity: "information" as const, message: action.title, source: "lsp" as const };
              return { title: action.title, diagnostics: context.markers, kind: action.kind || "quickfix", isPreferred: action.preferred, command: action.edit ? { id: "language-service.apply-code-action", title: action.title, arguments: [action] } : { id: "language-service.fix-diagnostic", title: action.title, arguments: [{ diagnostic, actionTitle: action.title }] } };
            });
            if (diagnostics[0]) {
              if (inlineEnabledRef.current) actions.push({ title: "使用 AI 内联修复", diagnostics: context.markers, kind: "quickfix", isPreferred: false, command: { id: "inline-edit.fix-diagnostic", title: "使用 AI 内联修复", arguments: [{ diagnostic: diagnostics[0], actionTitle: "" }] } });
              actions.push({ title: "交给 Agent 修复", diagnostics: context.markers, kind: "quickfix", isPreferred: false, command: { id: "language-service.fix-diagnostic", title: "交给 Agent 修复", arguments: [{ diagnostic: diagnostics[0], actionTitle: "" }] } });
            }
            return { actions, dispose: () => undefined };
          } }));
          editor.addAction({ id: "language-service.apply-code-action", label: "应用 Language Server 建议（生成 Patch）", run: async (_editor, action?: UnifiedCodeAction) => { if (!action?.edit) return; try { pendingPatchRef.current((await createLanguageWorkspaceEditPatch(action.edit, action.title)).patch); } catch (error) { errorRef.current(error instanceof Error ? error.message : "生成 Code Action Patch 失败"); } } });
          editor.addAction({ id: "language-service.fix-diagnostic", label: "交给 Agent 修复", run: (_editor, payload?: { diagnostic?: UnifiedDiagnostic; actionTitle?: string }) => { if (payload?.diagnostic) fixRef.current(payload.diagnostic, payload.actionTitle); } });
          editor.addAction({ id: "inline-edit.fix-diagnostic", label: "使用 AI 内联修复", run: (_editor, payload?: { diagnostic?: UnifiedDiagnostic }) => { const diagnostic = payload?.diagnostic; if (diagnostic) openInlineEditRef.current(`修复诊断：${diagnostic.message}`, diagnostic.range); } });
        }}
        onChange={(nextValue) => onChange(nextValue ?? "")}
          options={{ minimap: { enabled: false }, fontSize: 12, wordWrap: "on", scrollBeyondLastLine: false, automaticLayout: true }}
        />
      </div>
    </section>
  );
}
