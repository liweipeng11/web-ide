export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspLocation = { uri: string; range: LspRange };
export type LspDiagnostic = { range: LspRange; severity?: number; code?: string | number; source?: string; message: string };
export type LspSymbolInformation = { name: string; kind: number; location: LspLocation; containerName?: string };

export type LspServerCapabilities = {
  hoverProvider?: boolean | object;
  definitionProvider?: boolean | object;
  referencesProvider?: boolean | object;
  renameProvider?: boolean | object;
  workspaceSymbolProvider?: boolean | object;
  codeActionProvider?: boolean | object;
  textDocumentSync?: number | { openClose?: boolean; change?: number; save?: boolean | object };
};

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
