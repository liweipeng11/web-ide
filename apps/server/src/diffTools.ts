import { diffLines, structuredPatch } from "diff";
import type { EditHunk, PatchFileChange } from "./types.js";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function createDiffHtml(oldContent: string, newContent: string) {
  return diffLines(oldContent, newContent)
    .flatMap((part) => {
      const className = part.added ? "added" : part.removed ? "removed" : "unchanged";
      const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
      const lines = part.value.split("\n");

      if (lines.at(-1) === "") {
        lines.pop();
      }

      return lines.map((line) => `<span class="diff-line ${className}">${escapeHtml(prefix + line)}</span>`);
    })
    .join("");
}

export function createBinaryDiffHtml(status: PatchFileChange["status"]) {
  const label = status === "delete" ? "Binary file will be deleted. Content preview is hidden." : "Binary file changed. Content preview is hidden.";
  return `<span class="diff-line unchanged">${escapeHtml(label)}</span>`;
}

export function createMultiFileDiffHtml(files: PatchFileChange[]) {
  return files.map((file) => `<div class="diff-file-header">${escapeHtml(formatDiffFileTitle(file))}</div>${file.isBinary ? createBinaryDiffHtml(file.status) : file.diffHtml}`).join("");
}

export function formatDiffFileTitle(file: Pick<PatchFileChange, "path" | "status">) {
  if (file.status === "create") return `${file.path} (new file)`;
  if (file.status === "delete") return `${file.path} (deleted file)`;
  return file.path;
}

export function createEditHunks(oldContent: string, newContent: string): EditHunk[] {
  const patch = structuredPatch("old", "new", oldContent, newContent, "", "", { context: 3 });

  // 将 diff 库的行级补丁转换成稳定 JSON，前端和审批记录都可以直接展示或存档。
  return patch.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines: hunk.lines.map((line) => {
      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === "+") {
        return { type: "add" as const, content };
      }

      if (prefix === "-") {
        return { type: "remove" as const, content };
      }

      return { type: "context" as const, content };
    })
  }));
}
