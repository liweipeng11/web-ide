export type TextPosition = { line: number; column: number };
export type TextRange = { start: TextPosition; end: TextPosition };

export type InlineEditRequest = {
  filePath: string;
  documentVersion: number;
  selection: TextRange;
  selectedText: string;
  instruction: string;
  prefix: string;
  suffix: string;
  languageId: string;
  diagnostics?: Array<{ message: string; severity: "error" | "warning" | "info"; range?: TextRange }>;
};

export type InlineEditResult = {
  filePath: string;
  documentVersion: number;
  range: TextRange;
  replacement: string;
  summary: string;
  validationStatus: "not_run" | "passed" | "failed";
};

