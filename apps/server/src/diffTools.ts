import { diffLines } from "diff";
import type { PatchFileChange } from "./types.js";

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

export function createMultiFileDiffHtml(files: PatchFileChange[]) {
  return files.map((file) => `<div class="diff-file-header">${escapeHtml(file.status === "create" ? `${file.path} (new file)` : file.path)}</div>${file.diffHtml}`).join("");
}
