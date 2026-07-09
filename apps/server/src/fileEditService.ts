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

/**
 * 在工作区文件中执行精确 SEARCH/REPLACE，并返回写入后的完整文件内容。
 */
export async function replaceInFile(input: ReplaceInFileInput): Promise<FileEditResult> {
  if (!input.search) {
    throw new HttpError(422, "search must not be empty");
  }

  const oldContent = await readWorkspaceFile(input.filePath);
  const replacements = countExactMatches(oldContent, input.search);

  if (replacements === 0) {
    throw new SearchReplaceMismatchError(input.filePath);
  }

  // 默认只替换第一处命中；需要批量替换时由调用方显式传入 replaceAll。
  const nextContent = input.replaceAll ? oldContent.split(input.search).join(input.replace) : oldContent.replace(input.search, input.replace);
  await writeWorkspaceFile(input.filePath, nextContent);
  const finalContent = await readWorkspaceFile(input.filePath);

  return {
    filePath: input.filePath,
    oldContent,
    finalContent,
    changed: oldContent !== finalContent,
    replacements: input.replaceAll ? replacements : 1
  };
}

/**
 * 执行整文件写入；缺失文件必须显式允许创建，避免误把路径拼写错误当作新文件。
 */
export async function writeFile(input: WriteFileInput): Promise<FileEditResult> {
  let oldContent = "";

  try {
    oldContent = await readWorkspaceFile(input.filePath);
    await writeWorkspaceFile(input.filePath, input.content);
  } catch (error) {
    if (!isFileNotFoundError(error) || !input.createIfMissing) {
      throw error;
    }

    await createWorkspaceFile(input.filePath, input.content);
  }

  const finalContent = await readWorkspaceFile(input.filePath);

  return {
    filePath: input.filePath,
    oldContent,
    finalContent,
    changed: oldContent !== finalContent
  };
}
