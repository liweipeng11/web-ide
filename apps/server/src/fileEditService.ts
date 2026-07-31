import { HttpError } from "./errors.js";
import { createWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from "./fileTools.js";
import type { FileEditResult, ReplaceInFileInput, WriteFileInput } from "./types.js";

export class SearchReplaceMismatchError extends HttpError {
  readonly filePath: string;

  constructor(filePath: string) {
    super(422, `Search block was not found in ${filePath}`);
    // 调用方需要稳定识别替换失败，不能依赖错误文案反解析。
    this.name = "SearchReplaceMismatchError";
    this.filePath = filePath;
  }
}

function isFileNotFoundError(error: unknown) {
  return error instanceof HttpError && error.status === 404;
}

function countExactMatches(content: string, search: string) {
  return content.split(search).length - 1;
}

/** 计算精确替换结果但不写入文件，供 Safe Editor 在落盘前检查真实 diff。 */
export function resolveSearchReplaceContent(content: string, search: string, replace: string, replaceAll = false) {
  if (!search) throw new HttpError(422, "search must not be empty");
  const matches = countExactMatches(content, search);
  if (matches === 0) return null;
  return {
    content: replaceAll ? content.split(search).join(replace) : content.replace(search, replace),
    replacements: replaceAll ? matches : 1
  };
}

/**
 * 在工作区文件中执行精确 SEARCH/REPLACE，并返回写入后的完整文件内容。
 */
export async function replaceInFile(input: ReplaceInFileInput): Promise<FileEditResult> {
  if (!input.search) {
    throw new HttpError(422, "search must not be empty");
  }

  const oldContent = await readWorkspaceFile(input.filePath);
  const resolved = resolveSearchReplaceContent(oldContent, input.search, input.replace, input.replaceAll);

  if (!resolved) {
    throw new SearchReplaceMismatchError(input.filePath);
  }

  // 替换结果与原内容完全一致时直接返回，避免无意义写盘触发文件监听器。
  if (resolved.content === oldContent) {
    return {
      filePath: input.filePath,
      oldContent,
      finalContent: oldContent,
      changed: false,
      replacements: resolved.replacements,
      beforeExists: true,
      afterExists: true
    };
  }

  await writeWorkspaceFile(input.filePath, resolved.content);
  const finalContent = await readWorkspaceFile(input.filePath);

  return {
    filePath: input.filePath,
    oldContent,
    finalContent,
    changed: oldContent !== finalContent,
    replacements: resolved.replacements,
    beforeExists: true,
    afterExists: true
  };
}

/**
 * 执行整文件写入；缺失文件必须显式允许创建，避免误把路径拼写错误当作新文件。
 */
export async function writeFile(input: WriteFileInput): Promise<FileEditResult> {
  let oldContent = "";
  let beforeExists = true;

  try {
    oldContent = await readWorkspaceFile(input.filePath);
  } catch (error) {
    if (!isFileNotFoundError(error) || !input.createIfMissing) {
      throw error;
    }

    beforeExists = false;
    await createWorkspaceFile(input.filePath, input.content);
  }

  // 已有文件内容完全相同时保留原文件元数据，并返回完整内容供后续链路使用。
  if (beforeExists && oldContent === input.content) {
    return {
      filePath: input.filePath,
      oldContent,
      finalContent: oldContent,
      changed: false,
      beforeExists: true,
      afterExists: true
    };
  }

  if (beforeExists) {
    await writeWorkspaceFile(input.filePath, input.content);
  }

  const finalContent = await readWorkspaceFile(input.filePath);

  return {
    filePath: input.filePath,
    oldContent,
    finalContent,
    changed: oldContent !== finalContent,
    beforeExists,
    afterExists: true
  };
}
