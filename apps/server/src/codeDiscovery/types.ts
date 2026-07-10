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

export type { CodeSearchResult, FileTreeNode };
