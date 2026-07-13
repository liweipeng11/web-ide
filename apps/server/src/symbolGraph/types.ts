// Symbol Graph 支持的源码符号类别，覆盖改造计划要求的主要索引对象。
export type SymbolKind = "function" | "class" | "component" | "interface" | "type" | "enum" | "constant" | "variable" | "method";

export type SymbolLocation = {
  filePath: string;
  line: number;
  column: number;
};

export type SymbolDefinition = SymbolLocation & {
  id: string;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  defaultExport: boolean;
  containerName?: string;
};

export type SymbolReferenceKind = "reference" | "call" | "type" | "import" | "export";

export type SymbolReference = SymbolLocation & {
  name: string;
  kind: SymbolReferenceKind;
  targetSymbolId?: string;
  sourceSymbolId?: string;
  moduleSpecifier?: string;
};

export type ModuleDependency = {
  fromFile: string;
  toFile?: string;
  specifier: string;
  importedNames: string[];
};

export type SymbolGraph = {
  workspaceRoot: string;
  files: string[];
  symbols: SymbolDefinition[];
  references: SymbolReference[];
  dependencies: ModuleDependency[];
  unresolvedReferenceCount: number;
  indexTruncated: boolean;
};

export type SymbolQueryKind = "definition" | "references" | "reverseDependencies" | "callChain" | "typePropagation";

export type SymbolGraphQuery = {
  kind: SymbolQueryKind;
  symbolName?: string;
  filePath?: string;
  direction?: "incoming" | "outgoing" | "both";
  maxDepth?: number;
};

export type SymbolRelation = {
  depth: number;
  from?: SymbolDefinition;
  to?: SymbolDefinition;
  reference: SymbolReference;
};

export type SymbolGraphQueryResult = {
  query: SymbolGraphQuery;
  definitions: SymbolDefinition[];
  references: SymbolReference[];
  dependencies: ModuleDependency[];
  relations: SymbolRelation[];
  ambiguous: boolean;
  truncated: boolean;
  indexedFileCount: number;
  indexedSymbolCount: number;
  unresolvedReferenceCount: number;
  indexTruncated: boolean;
};

export type ParsedImport = {
  localName: string;
  importedName: string;
  moduleSpecifier: string;
  line: number;
  column: number;
  reExport?: boolean;
  namespaceImport?: boolean;
};

export type ParsedSourceFile = {
  filePath: string;
  symbols: SymbolDefinition[];
  references: SymbolReference[];
  imports: ParsedImport[];
  exports: Array<{ exportedName: string; localName: string }>;
  dependencies: ModuleDependency[];
};

export type BuildSymbolGraphOptions = {
  path?: string;
  maxFiles?: number;
};
