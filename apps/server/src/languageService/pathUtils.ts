import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

export function normalizeRelativePath(workspaceRoot: string, filePath: string) {
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);

  if (!filePath.trim() || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Language service path must stay inside the workspace");
  }

  return relative.split(path.sep).join("/");
}

export function toDocumentUri(workspaceRoot: string, filePath: string) {
  return pathToFileURL(path.resolve(workspaceRoot, normalizeRelativePath(workspaceRoot, filePath))).toString();
}

export function fromDocumentUri(workspaceRoot: string, uri: string) {
  if (!uri.startsWith("file:")) throw new Error("Language service only accepts file URIs");
  return normalizeRelativePath(workspaceRoot, fileURLToPath(uri));
}

export function languageIdForPath(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".ts") return "typescript";
  if (extension === ".tsx") return "typescriptreact";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
  if (extension === ".jsx") return "javascriptreact";
  if (extension === ".vue") return "vue";
  if (extension === ".py" || extension === ".pyi") return "python";
  return "plaintext";
}

export function supportsSymbolGraph(languageId: string) {
  return ["typescript", "typescriptreact", "javascript", "javascriptreact", "vue"].includes(languageId);
}

