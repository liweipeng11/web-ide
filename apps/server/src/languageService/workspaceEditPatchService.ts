import { HttpError } from "../errors.js";
import { createDiffHtml, createEditHunks, createMultiFileDiffHtml } from "../diffTools.js";
import { readWorkspaceFile } from "../fileTools.js";
import { createPendingPatch } from "../patchStore.js";
import type { WorkspaceEdit } from "../contracts/languageService.js";
import type { GenerateEditResponse, PatchFileChange } from "../types.js";

function lineStarts(content: string) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) if (content[index] === "\n") starts.push(index + 1);
  return starts;
}

function positionOffset(content: string, starts: number[], line: number, column: number) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1 || line > starts.length) throw new HttpError(422, "Workspace edit contains an invalid source position");
  const start = starts[line - 1];
  const rawEnd = line < starts.length ? starts[line] - 1 : content.length;
  const end = rawEnd > start && content[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
  const offset = start + column - 1;
  if (offset > end) throw new HttpError(422, "Workspace edit column is outside the target line");
  return offset;
}

function applyTextEdits(content: string, edits: WorkspaceEdit["changes"][string]) {
  const starts = lineStarts(content);
  const normalized = edits.map((edit) => ({
    start: positionOffset(content, starts, edit.range.start.line, edit.range.start.column),
    end: positionOffset(content, starts, edit.range.end.line, edit.range.end.column),
    newText: edit.newText
  })).sort((left, right) => right.start - left.start || right.end - left.end);

  let nextBoundary = content.length;
  let result = content;
  for (const edit of normalized) {
    if (edit.start > edit.end || edit.end > nextBoundary) throw new HttpError(422, "Workspace edit contains overlapping or reversed ranges");
    result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
    nextBoundary = edit.start;
  }
  return result;
}

/** 将 LSP WorkspaceEdit 转成现有可审阅 Patch，禁止语言服务绕过审批直接写盘。 */
export async function createWorkspaceEditPatchResponse(edit: WorkspaceEdit, summary: string, taskSessionId?: string): Promise<GenerateEditResponse> {
  const files: PatchFileChange[] = [];
  for (const [filePath, edits] of Object.entries(edit.changes)) {
    if (!edits.length) continue;
    const oldContent = await readWorkspaceFile(filePath);
    const newContent = applyTextEdits(oldContent, edits);
    if (newContent === oldContent) continue;
    files.push({
      path: filePath,
      filePath,
      status: "modify",
      oldContent,
      newContent,
      summary,
      diffHtml: createDiffHtml(oldContent, newContent),
      editHunks: createEditHunks(oldContent, newContent)
    });
  }
  if (!files.length) throw new HttpError(422, "Language service did not return an effective workspace edit");
  const patch = createPendingPatch(files, taskSessionId);
  const selected = files[0];
  return {
    taskSessionId,
    patchId: patch.patchId,
    finalSummary: summary,
    rawPatchCount: files.length,
    finalPatchCount: files.length,
    summary,
    files,
    oldContent: selected.oldContent,
    newContent: selected.newContent,
    diffHtml: createMultiFileDiffHtml(files)
  };
}

