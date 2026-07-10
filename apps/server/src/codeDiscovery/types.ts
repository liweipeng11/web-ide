import type { CodeSearchResult, FileTreeNode } from "../types.js";

// 路径解析选项，统一约束是否允许访问默认忽略的生成目录或运行态目录。
export type ResolveOptions = {
  allowIgnored?: boolean;
};

// 范围读取结果，供 Agent 工具和后续 chunk 读取能力复用。
export type WorkspaceFileRange = {
  content: string;
  startLine: number;
  endLine: number;
  linesRead: number;
  totalLines: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

// 标准分块读取结果，帮助 Agent 判断是否需要继续读取前后文。
export type WorkspaceFileChunk = WorkspaceFileRange & {
  nextStartLine?: number;
};

// 文件发现条目只描述路径结构，不读取文件内容，供 Agent 低成本缩小候选范围。
export type FileDiscoveryEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  depth: number;
};

// 文件名搜索结果保留匹配来源，方便 Agent 判断是命中文件名、扩展名还是目录片段。
export type FileNameSearchResult = FileDiscoveryEntry & {
  score: number;
  matchedBy: "name" | "extension" | "path";
};

// 结构级定义类型用于给 Agent 提供符号摘要，避免为了判断模块结构而读取完整文件内容。
export type CodeDefinitionKind = "function" | "class" | "interface" | "type" | "enum" | "component" | "variable";

export type CodeDefinition = {
  name: string;
  kind: CodeDefinitionKind;
  line: number;
  containerName?: string;
};

export type CodeDefinitionFileSummary = {
  filePath: string;
  language: "typescript" | "javascript" | "vue";
  definitions: CodeDefinition[];
  error?: string;
};

// 文本搜索选项集中在 discovery 层，确保 Agent 工具和旧 API 使用同一套范围控制语义。
export type TextSearchOptions = {
  path?: string;
  filePattern?: string;
  limit?: number;
  caseSensitive?: boolean;
  contextLines?: number;
};

export type { CodeSearchResult, FileTreeNode };
