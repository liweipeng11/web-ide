import fs from "node:fs/promises";
import path from "node:path";
import type { DocumentSyncRequest, HoverInfo, LanguageServiceCapability, LanguageServiceGateway, SourceLocation, SourceRange, UnifiedCodeAction, UnifiedDiagnostic, UnifiedDiagnosticSeverity, UnifiedSymbol, UnifiedSymbolKind, WorkspaceEdit } from "../contracts/languageService.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { LspProcessManager, type PublishedDiagnostics } from "./lspProcessManager.js";
import type { LspDiagnostic, LspLocation, LspRange, LspSymbolInformation } from "./lspTypes.js";
import { fromDocumentUri, languageIdForPath, normalizeRelativePath, supportsSymbolGraph, toDocumentUri } from "./pathUtils.js";
import { SymbolGraphLanguageAdapter } from "./symbolGraphAdapter.js";
import { TextSearchLanguageAdapter } from "./textSearchAdapter.js";

function toRange(range: LspRange): SourceRange {
  return { start: { line: range.start.line + 1, column: range.start.character + 1 }, end: { line: range.end.line + 1, column: range.end.character + 1 } };
}

function toLspPosition(location: SourceLocation) {
  return { line: Math.max(0, location.line - 1), character: Math.max(0, location.column - 1) };
}

function diagnosticSeverity(severity = 3): UnifiedDiagnosticSeverity {
  return severity === 1 ? "error" : severity === 2 ? "warning" : severity === 4 ? "hint" : "information";
}

const symbolKinds: UnifiedSymbolKind[] = ["file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum_member", "struct", "event", "operator", "type_parameter"];

function uniqueLocations(locations: SourceLocation[]) {
  const seen = new Map<string, SourceLocation>();
  for (const location of locations) {
    const key = `${location.filePath}:${location.line}:${location.column}:${location.endLine ?? ""}:${location.endColumn ?? ""}`;
    const existing = seen.get(key);
    if (!existing) seen.set(key, location);
    else if (existing.source !== location.source) seen.set(key, { ...existing, source: "combined", complete: Boolean(existing.complete && location.complete) });
  }
  return [...seen.values()];
}

function hoverText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value && typeof (value as { value?: unknown }).value === "string") return (value as { value: string }).value;
  if (Array.isArray(value)) return value.map(hoverText).filter(Boolean).join("\n\n");
  return "";
}

type LspTextEdit = { range: LspRange; newText: string };
type LspWorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: LspTextEdit[] }>;
};
type LspCodeAction = {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  edit?: LspWorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
  isPreferred?: boolean;
};

export type LanguageServiceGatewayOptions = { enabled: () => boolean; manager?: LspProcessManager; symbolGraph?: SymbolGraphLanguageAdapter; textSearch?: TextSearchLanguageAdapter };

export class DefaultLanguageServiceGateway implements LanguageServiceGateway {
  private readonly diagnostics = new Map<string, UnifiedDiagnostic[]>();
  private readonly documentVersions = new Map<string, number>();
  private readonly diagnosticRevisions = new Map<string, number>();
  private readonly manager: LspProcessManager;
  private readonly symbolGraph: SymbolGraphLanguageAdapter;
  private readonly textSearch: TextSearchLanguageAdapter;

  constructor(private readonly options: LanguageServiceGatewayOptions) {
    this.symbolGraph = options.symbolGraph ?? new SymbolGraphLanguageAdapter();
    this.textSearch = options.textSearch ?? new TextSearchLanguageAdapter();
    this.manager = options.manager ?? new LspProcessManager({ onDiagnostics: (value) => this.acceptDiagnostics(value) });
  }

  async getCapabilities(filePath: string): Promise<LanguageServiceCapability> {
    const { workspaceRoot, normalizedPath, languageId } = this.context(filePath);
    const graphAvailable = supportsSymbolGraph(languageId);
    const server = this.options.enabled() ? await this.manager.getServer(workspaceRoot, languageId) : null;
    const capabilities = server?.capabilities;
    const source = server && graphAvailable ? "combined" : server ? "lsp" : graphAvailable ? "symbol_graph" : languageId !== "plaintext" ? "text_search" : "none";
    return {
      languageId,
      diagnostics: Boolean(server),
      definition: Boolean(capabilities?.definitionProvider || graphAvailable),
      references: Boolean(capabilities?.referencesProvider || graphAvailable),
      hover: Boolean(capabilities?.hoverProvider || graphAvailable),
      workspaceSymbols: Boolean(capabilities?.workspaceSymbolProvider || graphAvailable),
      codeActions: Boolean(capabilities?.codeActionProvider),
      rename: Boolean(capabilities?.renameProvider),
      source,
      available: Boolean(server || graphAvailable || languageId !== "plaintext"),
      degraded: !server,
      detail: !this.options.enabled() ? "LSP 功能开关已关闭，当前使用 Symbol Graph 降级能力" : !server ? `${normalizedPath} 未发现可用的 ${languageId} Language Server` : undefined
    };
  }

  async syncDocument(request: DocumentSyncRequest) {
    const { workspaceRoot, normalizedPath } = this.context(request.filePath);
    const key = this.documentKey(workspaceRoot, normalizedPath);
    const currentVersion = this.documentVersions.get(key) ?? -1;
    if (request.action !== "close" && request.version < currentVersion) return;
    if (request.action === "close") {
      this.documentVersions.delete(key);
      this.diagnostics.delete(key);
      this.diagnosticRevisions.delete(key);
    } else this.documentVersions.set(key, request.version);
    if (this.options.enabled()) await this.manager.syncDocument(workspaceRoot, { ...request, filePath: normalizedPath });
  }

  async getDiagnostics(filePath?: string, documentVersion?: number) {
    const workspaceRoot = this.requireWorkspace();
    if (!filePath) return [...this.diagnostics.entries()].filter(([key]) => key.startsWith(`${workspaceRoot}\0`)).flatMap(([, diagnostics]) => diagnostics);
    const normalizedPath = normalizeRelativePath(workspaceRoot, filePath);
    const key = this.documentKey(workspaceRoot, normalizedPath);
    const currentVersion = this.documentVersions.get(key);
    if (documentVersion !== undefined && currentVersion !== undefined && documentVersion !== currentVersion) return [];
    if (currentVersion === undefined && this.options.enabled()) {
      const capability = await this.getCapabilities(normalizedPath);
      if (!capability.diagnostics) return [];
      // Agent 查询未在编辑器打开的文件时，短暂同步磁盘内容以触发 publishDiagnostics。
      const content = await fs.readFile(path.resolve(workspaceRoot, normalizedPath), "utf8");
      const revision = this.diagnosticRevisions.get(key) ?? 0;
      await this.syncDocument({ filePath: normalizedPath, content, version: 0, action: "open" });
      await this.waitForDiagnosticRevision(key, revision, 1_500);
      const result = this.diagnostics.get(key) ?? [];
      await this.syncDocument({ filePath: normalizedPath, version: 0, action: "close" });
      return result;
    }
    return this.diagnostics.get(key) ?? [];
  }

  async findDefinition(location: SourceLocation) {
    return this.queryLocations("textDocument/definition", location, () => this.symbolFallback(location, "definition"));
  }

  async findReferences(location: SourceLocation) {
    return this.queryLocations("textDocument/references", location, () => this.symbolFallback(location, "references"), { context: { includeDeclaration: true } });
  }

  async listWorkspaceSymbols(query: string) {
    const workspaceRoot = this.requireWorkspace();
    const servers = this.options.enabled() ? await this.findWorkspaceSymbolServers(workspaceRoot) : [];
    const lspSymbolGroups = await Promise.all(servers.map((server) => server.request<LspSymbolInformation[] | null>("workspace/symbol", { query }).catch(() => null)));
    const normalized = lspSymbolGroups.flatMap((symbols) => symbols ?? []).map((symbol): UnifiedSymbol | null => {
      try {
        const location = this.fromLspLocation(workspaceRoot, symbol.location);
        return { name: symbol.name, kind: symbolKinds[symbol.kind - 1] ?? "variable", containerName: symbol.containerName, location, source: "lsp" };
      } catch { return null; }
    }).filter((symbol): symbol is UnifiedSymbol => Boolean(symbol));
    const graphSymbols = await this.symbolGraph.listWorkspaceSymbols(workspaceRoot, query).catch(() => []);
    const seen = new Map<string, UnifiedSymbol>();
    for (const symbol of [...normalized, ...graphSymbols]) {
      const key = `${symbol.name}:${symbol.location.filePath}:${symbol.location.line}:${symbol.location.column}`;
      const existing = seen.get(key);
      seen.set(key, existing ? { ...existing, source: "combined", location: { ...existing.location, source: "combined" } } : symbol);
    }
    return [...seen.values()].slice(0, 200);
  }

  async getHover(location: SourceLocation): Promise<HoverInfo | null> {
    const { workspaceRoot, normalizedPath, languageId } = this.context(location.filePath);
    const server = this.options.enabled() ? await this.manager.getServer(workspaceRoot, languageId) : null;
    if (server?.capabilities.hoverProvider) {
      const result = await server.request<{ contents?: unknown; range?: LspRange } | null>("textDocument/hover", { textDocument: { uri: toDocumentUri(workspaceRoot, normalizedPath) }, position: toLspPosition(location) }).catch(() => null);
      const contents = hoverText(result?.contents);
      if (contents) return { contents, range: result?.range ? toRange(result.range) : undefined, source: "lsp" };
    }
    if (supportsSymbolGraph(languageId)) return this.symbolGraph.getHover(workspaceRoot, { ...location, filePath: normalizedPath });
    return null;
  }

  async getCodeActions(filePath: string, range: SourceRange, diagnostics: UnifiedDiagnostic[] = []): Promise<UnifiedCodeAction[]> {
    const { workspaceRoot, normalizedPath, languageId } = this.context(filePath);
    const server = this.options.enabled() ? await this.manager.getServer(workspaceRoot, languageId) : null;
    if (!server?.capabilities.codeActionProvider) return [];
    const result = await server.request<LspCodeAction[] | null>("textDocument/codeAction", {
      textDocument: { uri: toDocumentUri(workspaceRoot, normalizedPath) },
      range: { start: toLspPosition(range.start as SourceLocation), end: toLspPosition(range.end as SourceLocation) },
      context: {
        diagnostics: diagnostics.map((diagnostic) => ({
          range: { start: toLspPosition(diagnostic.range.start as SourceLocation), end: toLspPosition(diagnostic.range.end as SourceLocation) },
          severity: diagnostic.severity === "error" ? 1 : diagnostic.severity === "warning" ? 2 : diagnostic.severity === "information" ? 3 : 4,
          code: diagnostic.code,
          source: diagnostic.source,
          message: diagnostic.message
        }))
      }
    }).catch(() => null);
    return (result ?? []).filter((action) => Boolean(action?.title)).map((action) => ({
      title: action.title,
      kind: action.kind,
      diagnostics: diagnostics.length ? diagnostics : (action.diagnostics ?? []).map((diagnostic) => ({ filePath: normalizedPath, range: toRange(diagnostic.range), severity: diagnosticSeverity(diagnostic.severity), message: diagnostic.message, code: diagnostic.code, source: "lsp" })),
      edit: action.edit ? this.normalizeWorkspaceEdit(workspaceRoot, action.edit) : undefined,
      command: action.command,
      preferred: action.isPreferred,
      source: "lsp"
    }));
  }

  async rename(location: SourceLocation, newName: string): Promise<WorkspaceEdit> {
    if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(newName)) throw new Error("Rename target must be a valid identifier");
    const { workspaceRoot, normalizedPath, languageId } = this.context(location.filePath);
    const server = this.options.enabled() ? await this.manager.getServer(workspaceRoot, languageId) : null;
    if (!server?.capabilities.renameProvider) throw new Error("Rename is unavailable for this file");
    const result = await server.request<LspWorkspaceEdit | null>("textDocument/rename", { textDocument: { uri: toDocumentUri(workspaceRoot, normalizedPath) }, position: toLspPosition(location), newName });
    return this.normalizeWorkspaceEdit(workspaceRoot, result ?? {});
  }

  async disposeWorkspace(workspaceRoot: string) { await this.manager.disposeWorkspace(workspaceRoot); }
  async disposeAll() { await this.manager.disposeAll(); }

  private async queryLocations(method: string, location: SourceLocation, fallback: () => Promise<SourceLocation[]>, extra: Record<string, unknown> = {}) {
    const { workspaceRoot, normalizedPath, languageId } = this.context(location.filePath);
    const server = this.options.enabled() ? await this.manager.getServer(workspaceRoot, languageId) : null;
    const capability = method.endsWith("definition") ? server?.capabilities.definitionProvider : server?.capabilities.referencesProvider;
    const lspResult = capability
      ? await server!.request<LspLocation | LspLocation[] | null>(method, { textDocument: { uri: toDocumentUri(workspaceRoot, normalizedPath) }, position: toLspPosition(location), ...extra }).catch(() => null)
      : null;
    const lspLocations = (Array.isArray(lspResult) ? lspResult : lspResult ? [lspResult] : []).map((item) => {
      try { return this.fromLspLocation(workspaceRoot, item); } catch { return null; }
    }).filter((item): item is SourceLocation => Boolean(item));
    const graphLocations = supportsSymbolGraph(languageId) ? await fallback().catch(() => []) : [];
    const combined = uniqueLocations([...lspLocations, ...graphLocations]);
    if (combined.length) return combined;
    const textLocations = method.endsWith("definition")
      ? await this.textSearch.findDefinition(workspaceRoot, { ...location, filePath: normalizedPath }).catch(() => [])
      : await this.textSearch.findReferences(workspaceRoot, { ...location, filePath: normalizedPath }).catch(() => []);
    return uniqueLocations(textLocations);
  }

  private async symbolFallback(location: SourceLocation, kind: "definition" | "references") {
    const workspaceRoot = this.requireWorkspace();
    return kind === "definition" ? this.symbolGraph.findDefinition(workspaceRoot, location) : this.symbolGraph.findReferences(workspaceRoot, location);
  }

  private fromLspLocation(workspaceRoot: string, location: LspLocation): SourceLocation {
    return { filePath: fromDocumentUri(workspaceRoot, location.uri), line: location.range.start.line + 1, column: location.range.start.character + 1, endLine: location.range.end.line + 1, endColumn: location.range.end.character + 1, source: "lsp", complete: true };
  }

  private acceptDiagnostics(value: PublishedDiagnostics) {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;
    let filePath: string;
    try { filePath = fromDocumentUri(workspaceRoot, value.uri); } catch { return; }
    const key = this.documentKey(workspaceRoot, filePath);
    const currentVersion = this.documentVersions.get(key);
    // 带版本的旧诊断必须丢弃，避免覆盖用户当前未保存内容。
    if (value.version !== undefined && currentVersion !== undefined && value.version !== currentVersion) return;
    const diagnostics = (value.diagnostics ?? []).map((item: LspDiagnostic): UnifiedDiagnostic => ({ filePath, range: toRange(item.range), severity: diagnosticSeverity(item.severity), message: item.message, code: item.code, source: "lsp", documentVersion: value.version }));
    this.diagnostics.set(key, diagnostics);
    this.diagnosticRevisions.set(key, (this.diagnosticRevisions.get(key) ?? 0) + 1);
  }

  private async findWorkspaceSymbolServers(workspaceRoot: string) {
    const servers = await Promise.all(["typescript", "vue", "python"].map((languageId) => this.manager.getServer(workspaceRoot, languageId)));
    return servers.filter((server): server is NonNullable<typeof server> => Boolean(server?.capabilities.workspaceSymbolProvider));
  }

  private normalizeWorkspaceEdit(workspaceRoot: string, edit: LspWorkspaceEdit): WorkspaceEdit {
    const changes: WorkspaceEdit["changes"] = {};
    const append = (uri: string, edits: LspTextEdit[]) => {
      const filePath = fromDocumentUri(workspaceRoot, uri);
      changes[filePath] = [...(changes[filePath] ?? []), ...edits.map((item) => ({ range: toRange(item.range), newText: item.newText }))];
    };
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) append(uri, edits);
    for (const documentChange of edit.documentChanges ?? []) {
      if (documentChange.textDocument?.uri && Array.isArray(documentChange.edits)) append(documentChange.textDocument.uri, documentChange.edits);
    }
    return { changes, source: "lsp" };
  }

  private async waitForDiagnosticRevision(key: string, previousRevision: number, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while ((this.diagnosticRevisions.get(key) ?? 0) <= previousRevision && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  private context(filePath: string) {
    const workspaceRoot = this.requireWorkspace();
    const normalizedPath = normalizeRelativePath(workspaceRoot, filePath);
    return { workspaceRoot, normalizedPath, languageId: languageIdForPath(normalizedPath) };
  }

  private requireWorkspace() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) throw new Error("No workspace selected");
    return path.resolve(workspaceRoot);
  }

  private documentKey(workspaceRoot: string, filePath: string) { return `${workspaceRoot}\0${filePath}`; }
}
