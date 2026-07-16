export type LanguageServiceSource = "lsp" | "symbol_graph" | "text_search" | "combined" | "none";

export type SourcePosition = {
  /** LSP 与 Monaco 均使用从 1 开始的行列，避免跨层重复换算。 */
  line: number;
  column: number;
};

export type SourceRange = {
  start: SourcePosition;
  end: SourcePosition;
};

export type SourceLocation = SourcePosition & {
  filePath: string;
  endLine?: number;
  endColumn?: number;
  source?: LanguageServiceSource;
  complete?: boolean;
};

export type LanguageServiceCapability = {
  languageId: string;
  diagnostics: boolean;
  definition: boolean;
  references: boolean;
  hover: boolean;
  workspaceSymbols: boolean;
  codeActions: boolean;
  rename: boolean;
  source: LanguageServiceSource;
  available: boolean;
  degraded: boolean;
  detail?: string;
};

export type UnifiedDiagnosticSeverity = "error" | "warning" | "information" | "hint";

export type UnifiedDiagnostic = {
  filePath: string;
  range: SourceRange;
  severity: UnifiedDiagnosticSeverity;
  message: string;
  code?: string | number;
  source: LanguageServiceSource;
  documentVersion?: number;
};

export type UnifiedSymbolKind =
  | "file"
  | "module"
  | "namespace"
  | "package"
  | "class"
  | "method"
  | "property"
  | "field"
  | "constructor"
  | "enum"
  | "interface"
  | "function"
  | "variable"
  | "constant"
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "key"
  | "null"
  | "enum_member"
  | "struct"
  | "event"
  | "operator"
  | "type_parameter"
  | "type";

export type UnifiedSymbol = {
  name: string;
  kind: UnifiedSymbolKind;
  location: SourceLocation;
  containerName?: string;
  source: LanguageServiceSource;
};

export type HoverInfo = {
  contents: string;
  range?: SourceRange;
  source: LanguageServiceSource;
};

export type TextEdit = {
  range: SourceRange;
  newText: string;
};

export type WorkspaceEdit = {
  changes: Record<string, TextEdit[]>;
  source: LanguageServiceSource;
};

export type UnifiedCodeAction = {
  title: string;
  kind?: string;
  diagnostics: UnifiedDiagnostic[];
  edit?: WorkspaceEdit;
  command?: { title: string; command: string; arguments?: unknown[] };
  preferred?: boolean;
  source: LanguageServiceSource;
};

export type DocumentSyncRequest = {
  filePath: string;
  content?: string;
  version: number;
  action: "open" | "change" | "save" | "close";
};

export interface LanguageServiceGateway {
  getCapabilities(filePath: string): Promise<LanguageServiceCapability>;
  syncDocument(request: DocumentSyncRequest): Promise<void>;
  getDiagnostics(filePath?: string, documentVersion?: number): Promise<UnifiedDiagnostic[]>;
  findDefinition(location: SourceLocation): Promise<SourceLocation[]>;
  findReferences(location: SourceLocation): Promise<SourceLocation[]>;
  listWorkspaceSymbols(query: string): Promise<UnifiedSymbol[]>;
  getHover(location: SourceLocation): Promise<HoverInfo | null>;
  getCodeActions(filePath: string, range: SourceRange, diagnostics?: UnifiedDiagnostic[]): Promise<UnifiedCodeAction[]>;
  rename(location: SourceLocation, newName: string): Promise<WorkspaceEdit>;
}
