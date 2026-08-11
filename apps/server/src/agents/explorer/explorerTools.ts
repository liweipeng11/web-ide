import {
  listWorkspaceFiles,
  readWorkspaceFileChunk,
  searchTextLiteral,
  searchTextRegex,
  searchWorkspaceFilesByName
} from "../../codeDiscovery/index.js";
import type { RuntimeTool } from "../../runtime/contracts.js";
import { runtimeError } from "../../runtime/errors.js";

const MAX_LIST_RESULTS = 500;
const MAX_FILE_RESULTS = 50;
const MAX_GREP_RESULTS = 100;
const MAX_READ_LINES = 200;

function optionalString(args: Record<string, unknown>, name: string, fallback = "") {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") throw runtimeError("INVALID_CONTRACT", `${name} 必须是字符串。`);
  return value.trim();
}

function requiredString(args: Record<string, unknown>, name: string) {
  const value = optionalString(args, name);
  if (!value) throw runtimeError("INVALID_CONTRACT", `${name} 不能为空。`);
  return value;
}

function boundedInteger(args: Record<string, unknown>, name: string, fallback: number, max: number, min = 1) {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min) {
    throw runtimeError("INVALID_CONTRACT", `${name} 必须是大于等于 ${min} 的整数。`);
  }
  return Math.min(Number(value), max);
}

function searchScopeTarget(args: Record<string, unknown>) {
  const base = optionalString(args, "path").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  // 目录和搜索工具以 glob 探针声明访问范围，实际路径仍由 codeDiscovery 再做工作区校验。
  return [base ? `${base}/**` : "**"];
}

export const EXPLORER_TOOL_NAMES = ["list_directory", "search_files", "grep", "read_file"] as const;

export const explorerRuntimeTools: RuntimeTool[] = [
  {
    name: "list_directory",
    description: "列出工作区目录项，可选择受限递归；不会读取文件正文。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_RESULTS }
      },
      additionalProperties: false
    },
    getTargetPaths: searchScopeTarget,
    async execute(args) {
      const path = optionalString(args, "path");
      const recursive = args.recursive === true;
      const limit = boundedInteger(args, "limit", 200, MAX_LIST_RESULTS);
      return listWorkspaceFiles(path, { recursive, limit });
    }
  },
  {
    name: "search_files",
    description: "按名称、扩展名或路径片段搜索工作区文件。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_FILE_RESULTS }
      },
      required: ["query"],
      additionalProperties: false
    },
    getTargetPaths: searchScopeTarget,
    async execute(args) {
      return searchWorkspaceFilesByName(
        requiredString(args, "query"),
        optionalString(args, "path"),
        boundedInteger(args, "limit", 30, MAX_FILE_RESULTS)
      );
    }
  },
  {
    name: "grep",
    description: "在工作区文本文件中执行字面量或正则搜索，并返回行号和少量上下文。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        filePattern: { type: "string" },
        regex: { type: "boolean" },
        caseSensitive: { type: "boolean" },
        contextLines: { type: "integer", minimum: 0, maximum: 5 },
        limit: { type: "integer", minimum: 1, maximum: MAX_GREP_RESULTS }
      },
      required: ["pattern"],
      additionalProperties: false
    },
    getTargetPaths: searchScopeTarget,
    async execute(args) {
      const options = {
        path: optionalString(args, "path"),
        filePattern: optionalString(args, "filePattern") || undefined,
        caseSensitive: args.caseSensitive === true,
        contextLines: boundedInteger(args, "contextLines", 1, 5, 0),
        limit: boundedInteger(args, "limit", 50, MAX_GREP_RESULTS)
      };
      const pattern = requiredString(args, "pattern");
      return args.regex === true ? searchTextRegex(pattern, options) : searchTextLiteral(pattern, options);
    }
  },
  {
    name: "read_file",
    description: "按行分块读取一个工作区文本文件，单次最多读取 200 行。",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 }
      },
      required: ["filePath"],
      additionalProperties: false
    },
    getTargetPaths: (args) => [requiredString(args, "filePath")],
    async execute(args) {
      const startLine = boundedInteger(args, "startLine", 1, Number.MAX_SAFE_INTEGER);
      const requestedEnd = boundedInteger(args, "endLine", startLine + MAX_READ_LINES - 1, Number.MAX_SAFE_INTEGER);
      const endLine = Math.min(requestedEnd, startLine + MAX_READ_LINES - 1);
      return readWorkspaceFileChunk(requiredString(args, "filePath"), startLine, endLine);
    }
  }
];

