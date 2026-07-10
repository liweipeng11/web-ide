import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "../errors.js";
import type { CodeDefinition, CodeDefinitionFileSummary, ResolveOptions } from "./types.js";
import { listWorkspaceFiles } from "./fileDiscovery.js";
import { hasIgnoredSegment, safeResolve, toWorkspaceRelative } from "./pathPolicy.js";

const DEFAULT_DEFINITION_LIMIT = 80;
const MAX_DEFINITION_LIMIT = 500;
const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".vue"]);

type DefinitionLanguage = CodeDefinitionFileSummary["language"];

function normalizeLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_DEFINITION_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "limit must be a positive integer");
  }

  return Math.min(value, MAX_DEFINITION_LIMIT);
}

function getLanguage(filePath: string): DefinitionLanguage | null {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".vue") return "vue";
  if (extension === ".ts" || extension === ".tsx") return "typescript";
  if (extension === ".js" || extension === ".jsx") return "javascript";
  return null;
}

function countBraceDelta(line: string) {
  const withoutComments = line.replace(/\/\/.*$/, "");
  const opens = (withoutComments.match(/\{/g) || []).length;
  const closes = (withoutComments.match(/\}/g) || []).length;

  return opens - closes;
}

function pushDefinition(definitions: CodeDefinition[], definition: CodeDefinition) {
  const exists = definitions.some((item) => item.name === definition.name && item.kind === definition.kind && item.line === definition.line);

  if (!exists) definitions.push(definition);
}

function detectVueComponentName(lines: string[], lineIndex: number) {
  for (let index = lineIndex + 1; index < Math.min(lines.length, lineIndex + 20); index += 1) {
    const nameMatch = lines[index].match(/\bname\s*:\s*["'`]([A-Za-z_$][\w$-]*)["'`]/);
    if (nameMatch) return nameMatch[1];
  }

  return undefined;
}

function classifyConstDefinition(line: string): CodeDefinition["kind"] {
  if (/\b(?:defineComponent|memo|forwardRef)\s*\(/.test(line)) return "component";
  if (/=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(line)) return "function";
  if (/=\s*(?:async\s+)?function\b/.test(line)) return "function";
  return "variable";
}

/**
 * 从单个源码文件中提取顶级定义摘要。
 * 第一版刻意使用轻量级规则，目标是稳定给出导航线索，而不是替代完整 AST 解析。
 */
export function extractCodeDefinitions(content: string, filePath: string): CodeDefinitionFileSummary {
  const language = getLanguage(filePath);

  if (!language) {
    throw new HttpError(400, "Unsupported code definition file type");
  }

  const lines = content.split(/\r?\n/);
  const definitions: CodeDefinition[] = [];
  let braceDepth = 0;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const currentDepth = braceDepth;
    const lineNumber = index + 1;

    // 只提取顶级符号，避免把函数体内部的临时变量误认为模块定义。
    if (currentDepth <= 0 && trimmed && !trimmed.startsWith("//")) {
      const functionMatch = trimmed.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/);
      const classMatch = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/);
      const enumMatch = trimmed.match(/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/);
      const constMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/);
      const vueDefaultMatch = language === "vue" ? trimmed.match(/^export\s+default\s+(?:defineComponent\s*\(|\{)/) : null;

      if (functionMatch) {
        pushDefinition(definitions, { name: functionMatch[1], kind: "function", line: lineNumber });
      } else if (classMatch) {
        pushDefinition(definitions, { name: classMatch[1], kind: "class", line: lineNumber });
      } else if (interfaceMatch) {
        pushDefinition(definitions, { name: interfaceMatch[1], kind: "interface", line: lineNumber });
      } else if (typeMatch) {
        pushDefinition(definitions, { name: typeMatch[1], kind: "type", line: lineNumber });
      } else if (enumMatch) {
        pushDefinition(definitions, { name: enumMatch[1], kind: "enum", line: lineNumber });
      } else if (constMatch) {
        pushDefinition(definitions, { name: constMatch[1], kind: classifyConstDefinition(trimmed), line: lineNumber });
      } else if (vueDefaultMatch) {
        pushDefinition(definitions, {
          name: detectVueComponentName(lines, index) || "default",
          kind: "component",
          line: lineNumber
        });
      }
    }

    braceDepth = Math.max(0, braceDepth + countBraceDelta(line));
  });

  return { filePath, language, definitions };
}

async function collectDefinitionFiles(targetPath: string, includeIgnored: boolean) {
  const absolutePath = safeResolve(targetPath, { allowIgnored: includeIgnored });
  const stat = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Path not found");
    }
    throw error;
  });

  if (stat.isFile()) {
    const relativePath = toWorkspaceRelative(absolutePath);
    return getLanguage(relativePath) ? [relativePath] : [];
  }

  if (!stat.isDirectory()) {
    throw new HttpError(400, "Path is not a file or directory");
  }

  const entries = await listWorkspaceFiles(targetPath, {
    recursive: true,
    limit: MAX_DEFINITION_LIMIT * 10,
    allowIgnored: includeIgnored
  });

  return entries
    .filter((entry) => entry.type === "file" && getLanguage(entry.path))
    .map((entry) => entry.path);
}

/**
 * 列出目录或单文件中的代码定义名称。
 * 返回值只包含结构摘要，方便 Agent 先判断模块职责，再决定是否读取具体文件。
 */
export async function listCodeDefinitionNames(targetPath = "", limit?: number, options: ResolveOptions = {}): Promise<CodeDefinitionFileSummary[]> {
  const boundedLimit = normalizeLimit(limit);
  const includeIgnored = options.allowIgnored === true;
  const files = await collectDefinitionFiles(targetPath, includeIgnored);
  const summaries: CodeDefinitionFileSummary[] = [];

  for (const filePath of files) {
    if (summaries.length >= boundedLimit) break;
    if (!includeIgnored && hasIgnoredSegment(filePath)) continue;

    try {
      const content = await fs.readFile(safeResolve(filePath, { allowIgnored: includeIgnored }), "utf8");
      const summary = extractCodeDefinitions(content, filePath);

      if (summary.definitions.length > 0) {
        summaries.push(summary);
      }
    } catch (error) {
      // 单文件解析失败只标记当前文件，避免一次坏文件阻断整个结构发现流程。
      const language = getLanguage(filePath);
      if (language) {
        summaries.push({
          filePath,
          language,
          definitions: [],
          error: error instanceof Error ? error.message : "Failed to extract definitions"
        });
      }
    }
  }

  return summaries;
}
