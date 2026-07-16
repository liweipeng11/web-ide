export type TextPosition = { line: number; column: number };
export type TextRange = { start: TextPosition; end: TextPosition };

export type InlineEditRequest = {
  filePath: string;
  documentVersion: number;
  documentLineCount: number;
  selectionStartLineMaxColumn: number;
  selectionEndLineMaxColumn: number;
  selection: TextRange;
  selectedText: string;
  instruction: string;
  prefix: string;
  suffix: string;
  languageId: string;
  diagnostics?: Array<{ message: string; severity: "error" | "warning" | "info"; range?: TextRange }>;
  projectRules?: string | null;
  relatedContext?: string | null;
};

export type InlineEditCandidate = {
  filePath: string;
  baseVersion: number;
  range: TextRange;
  replacement: string;
  explanation?: string;
};

export type InlineEditResult =
  | { mode: "inline"; candidate: InlineEditCandidate }
  | { mode: "patch_review"; reason: string };

export type InlineEditStreamEvent =
  | { type: "started" }
  | { type: "delta"; generatedCharacters: number }
  | { type: "candidate_delta"; replacement: string }
  | { type: "result"; result: InlineEditResult }
  | { type: "error"; message: string };
