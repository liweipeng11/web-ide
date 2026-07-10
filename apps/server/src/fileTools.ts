// 兼容旧文件工具入口，实际实现已迁移到 codeDiscovery 分层模块。
export { hasIgnoredSegment, safeResolve, toWorkspaceRelative } from "./codeDiscovery/pathPolicy.js";
export {
  createWorkspaceFile,
  deleteWorkspaceFile,
  listFiles,
  readWorkspaceFile,
  readWorkspaceFileBuffer,
  readWorkspaceFileChunk,
  readWorkspaceFileForDiff,
  readWorkspaceFileRange,
  workspacePathExists,
  writeWorkspaceFile
} from "./codeDiscovery/readFile.js";
export type { ResolveOptions, WorkspaceFileChunk, WorkspaceFileRange } from "./codeDiscovery/types.js";
