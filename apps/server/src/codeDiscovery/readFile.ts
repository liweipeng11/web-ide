import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { HttpError } from "../errors.js";
import type { FileTreeNode, ResolveOptions, WorkspaceFileRange } from "./types.js";
import { hasIgnoredSegment, safeResolve, toWorkspaceRelative } from "./pathPolicy.js";

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avif",
  ".bmp",
  ".class",
  ".dll",
  ".doc",
  ".docx",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".pdf",
  ".png",
  ".rar",
  ".tar",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip"
]);

function assertWorkspaceFile(absolutePath: string) {
  return fs.stat(absolutePath).then((stat) => {
    if (!stat.isFile()) {
      throw new HttpError(400, "Path is not a file");
    }

    return stat;
  });
}

// 通过空字节和 UTF-8 严格解码双重判断，避免把二进制文件当文本塞进上下文。
function isLikelyBinaryBuffer(buffer: Buffer) {
  if (buffer.includes(0)) {
    return true;
  }

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

// 递归生成文件树，保留旧接口的默认忽略行为和排序规则。
export async function listFiles(dir = "", includeIgnored = false): Promise<FileTreeNode[]> {
  const absoluteDir = safeResolve(dir, { allowIgnored: includeIgnored });
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "Directory not found");
    }
    throw error;
  });

  const visibleEntries = entries
    .filter((entry) => {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = toWorkspaceRelative(absolutePath);
      return includeIgnored || !hasIgnoredSegment(relativePath);
    })
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const nodes = await Promise.all(
    visibleEntries.map(async (entry) => {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = toWorkspaceRelative(absolutePath);

      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: relativePath,
          type: "directory" as const,
          children: await listFiles(relativePath, includeIgnored)
        };
      }

      return {
        name: entry.name,
        path: relativePath,
        type: "file" as const
      };
    })
  );

  return nodes;
}

// 读取工作区文本文件，所有入口统一先经过路径策略校验。
export async function readWorkspaceFile(filePath: string, options: ResolveOptions = {}) {
  const absolutePath = safeResolve(filePath, options);
  const stat = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "File not found");
    }
    throw error;
  });

  if (!stat.isFile()) {
    throw new HttpError(400, "Path is not a file");
  }

  return fs.readFile(absolutePath, "utf8");
}

export async function readWorkspaceFileBuffer(filePath: string, options: ResolveOptions = {}) {
  const absolutePath = safeResolve(filePath, options);
  await assertWorkspaceFile(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "File not found");
    }
    throw error;
  });

  return fs.readFile(absolutePath);
}

// diff 场景需要同时返回文本内容和 base64，二进制文件只暴露 base64。
export async function readWorkspaceFileForDiff(filePath: string, options: ResolveOptions = {}) {
  const buffer = await readWorkspaceFileBuffer(filePath, options);
  const extension = path.extname(filePath).toLowerCase();
  const isBinary = BINARY_EXTENSIONS.has(extension) || isLikelyBinaryBuffer(buffer);

  return {
    content: isBinary ? "" : buffer.toString("utf8"),
    contentBase64: buffer.toString("base64"),
    isBinary,
    size: buffer.length
  };
}

// 按 1-based 闭区间读取文件片段，为后续 chunk 读取接口保留清晰边界信息。
export async function readWorkspaceFileRange(filePath: string, startLine: number, endLine: number, options: ResolveOptions = {}): Promise<WorkspaceFileRange> {
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new HttpError(400, "startLine must be a positive integer");
  }

  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new HttpError(400, "endLine must be an integer greater than or equal to startLine");
  }

  const content = await readWorkspaceFile(filePath, options);
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  const boundedStartLine = Math.min(startLine, totalLines + 1);
  const boundedEndLine = Math.min(endLine, totalLines);
  const selectedLines = boundedStartLine <= boundedEndLine ? lines.slice(boundedStartLine - 1, boundedEndLine) : [];
  const actualEndLine = selectedLines.length ? boundedStartLine + selectedLines.length - 1 : boundedStartLine - 1;

  return {
    content: selectedLines.join("\n"),
    startLine: boundedStartLine,
    endLine: actualEndLine,
    linesRead: selectedLines.length,
    totalLines,
    hasMoreBefore: boundedStartLine > 1,
    hasMoreAfter: actualEndLine < totalLines
  };
}

export async function writeWorkspaceFile(filePath: string, content: string) {
  const absolutePath = safeResolve(filePath);
  const stat = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "File not found");
    }
    throw error;
  });

  if (!stat.isFile()) {
    throw new HttpError(400, "Path is not a file");
  }

  await fs.writeFile(absolutePath, content, "utf8");
}

export async function createWorkspaceFile(filePath: string, content: string) {
  const absolutePath = safeResolve(filePath);
  const existing = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });

  if (existing) {
    throw new HttpError(409, "File already exists");
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

export async function deleteWorkspaceFile(filePath: string) {
  const absolutePath = safeResolve(filePath);
  const stat = await fs.stat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(404, "File not found");
    }
    throw error;
  });

  if (!stat.isFile()) {
    throw new HttpError(400, "Path is not a file");
  }

  // 删除能力只允许作用于工作区内普通文件，目录删除继续交给显式命令审批。
  await fs.rm(absolutePath, { force: true });
}

export async function workspacePathExists(filePath: string) {
  const absolutePath = safeResolve(filePath);
  return fs
    .stat(absolutePath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    });
}
