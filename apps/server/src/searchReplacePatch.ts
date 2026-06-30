import { HttpError } from "./errors.js";
import type { FilePatch, SearchReplaceEdit } from "./types.js";

const riskyRemovalLineCount = 25;
const riskyRemovalRatio = 0.3;

export class StaleFullFileRewriteError extends HttpError {
  constructor(filePath: string) {
    super(422, `AI edit for ${filePath} was based on stale or incomplete file content`);
  }
}

function countLines(content: string) {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function isDestructiveRequest(userRequest: string) {
  return /(?:删除|移除|清空|重写|重构|精简|替换整个|删掉|remove|delete|rewrite|refactor|clear|replace all)/i.test(userRequest);
}

function countRemovedLines(oldContent: string, newContent: string) {
  const oldLines = oldContent.split(/\r?\n/);
  const newLineSet = new Set(newContent.split(/\r?\n/));

  return oldLines.filter((line) => line.trim() && !newLineSet.has(line)).length;
}

function assertSafeRemovalImpact(filePath: string, oldContent: string, newContent: string, userRequest: string) {
  if (isDestructiveRequest(userRequest)) {
    return;
  }

  const oldLineCount = countLines(oldContent);
  const removedLineCount = countRemovedLines(oldContent, newContent);
  const removalRatio = oldLineCount ? removedLineCount / oldLineCount : 0;

  /*
   * 非删除类需求如果造成大量原代码消失，优先拦截，
   * 避免“小改动”变成整文件覆盖事故。
   */
  if (removedLineCount >= riskyRemovalLineCount && removalRatio >= riskyRemovalRatio) {
    throw new HttpError(
      422,
      `AI edit for ${filePath} removes ${removedLineCount} existing lines (${Math.round(removalRatio * 100)}%). Refusing because the user request does not look like a destructive rewrite.`
    );
  }
}

export function applySearchReplaceEdits(filePath: string, originalContent: string, edits: SearchReplaceEdit[]) {
  let nextContent = originalContent;

  for (const edit of edits) {
    if (!edit.search) {
      throw new HttpError(422, `AI edit for ${filePath} contains an empty search block`);
    }

    const matchCount = nextContent.split(edit.search).length - 1;

    if (matchCount === 0) {
      throw new HttpError(422, `AI edit for ${filePath} could not find a search block in the current file`);
    }

    if (matchCount > 1 && !edit.replaceAll) {
      throw new HttpError(422, `AI edit for ${filePath} matched a search block ${matchCount} times; refusing ambiguous replacement`);
    }

    nextContent = edit.replaceAll ? nextContent.split(edit.search).join(edit.replace) : nextContent.replace(edit.search, edit.replace);
  }

  return nextContent;
}

export function resolvePatchNewContent(filePath: string, patch: FilePatch, previousContent: string, userRequest: string) {
  if (patch.edits?.length) {
    const newContent = applySearchReplaceEdits(filePath, previousContent, patch.edits);
    assertSafeRemovalImpact(filePath, previousContent, newContent, userRequest);
    return newContent;
  }

  /*
   * 整文件写入必须证明模型基于当前文件生成，
   * 不能把截断上下文当成完整文件覆盖。
   */
  if (patch.oldContent !== previousContent) {
    throw new StaleFullFileRewriteError(filePath);
  }

  assertSafeRemovalImpact(filePath, previousContent, patch.newContent, userRequest);
  return patch.newContent;
}
