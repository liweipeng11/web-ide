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

export type { CodeSearchResult, FileTreeNode };
