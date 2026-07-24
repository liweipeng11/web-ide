import type { SymbolDefinition, SymbolReferenceKind } from "../symbolGraph/index.js";

export type ImpactChangeKind = "add" | "modify" | "delete" | "rename" | "signature";

// 单个拟变更目标；symbolName 缺省时按整个文件分析。
export type ImpactChangeTarget = {
  filePath: string;
  symbolName?: string;
  changeKind?: ImpactChangeKind;
};

export type ImpactAnalysisOptions = {
  maxDepth?: number;
  maxFiles?: number;
};

export type ImpactReasonKind = "symbol_reference" | "module_dependency";

export type ImpactReason = {
  kind: ImpactReasonKind;
  sourceFile: string;
  targetFile: string;
  symbolName?: string;
  referenceKind?: SymbolReferenceKind;
};

export type ImpactCategory = "test" | "route" | "entrypoint" | "configuration" | "type_contract" | "implementation";

export type ImpactedFile = {
  filePath: string;
  depth: number;
  impact: "direct" | "indirect";
  categories: ImpactCategory[];
  reasons: ImpactReason[];
  affectedSymbols: SymbolDefinition[];
};

export type ImpactTargetResolution = ImpactChangeTarget & {
  status: "resolved" | "missing" | "ambiguous";
  definitions: SymbolDefinition[];
};

export type ImpactRisk = {
  level: "low" | "medium" | "high";
  score: number;
  factors: string[];
};

export type ImpactAnalysisResult = {
  /** 分析完成时间，用于动态预检判断已有证据是否仍在有效期内。 */
  analyzedAt?: number;
  changes: ImpactTargetResolution[];
  impactedFiles: ImpactedFile[];
  relatedTests: string[];
  boundaryFiles: string[];
  risk: ImpactRisk;
  diagnostics: string[];
  complete: boolean;
  truncated: boolean;
  indexedFileCount: number;
  indexedSymbolCount: number;
  // 本次变更影响链中可能阻断继续传播的未解析引用数量。
  unresolvedReferenceCount: number;
  // 整个符号索引的未解析引用数量，仅作为索引质量信息，不直接决定本次分析完整性。
  indexedUnresolvedReferenceCount: number;
};

export type TraversalSeed = {
  filePath: string;
  symbols: SymbolDefinition[];
};

export type TraversalImpact = {
  filePath: string;
  depth: number;
  reasons: ImpactReason[];
  affectedSymbolIds: Set<string>;
};
