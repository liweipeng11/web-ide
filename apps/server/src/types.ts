export type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileTreeNode[];
};

export type ReadFileResponse = {
  path: string;
  content: string;
};

export type GenerateEditRequest = {
  path: string;
  userRequest: string;
};

export type SaveFileRequest = {
  path: string;
  content: string;
};

export type CodeSearchResult = {
  path: string;
  line: number;
  column: number;
  text: string;
  match: string;
};

export type PackageScript = {
  name: string;
  command: string;
};

export type ProjectCommand = PackageScript & {
  source: string;
  language: string;
  packageManager?: string;
  dependencyState?: "installed" | "missing" | "unknown";
};

export type CommandResult = {
  command: string;
  chatId?: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
};

export type RunCommandRequest = {
  command: string;
  chatId?: string;
  cwd?: string;
};

export type FileChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type FileChatHistoryItem = {
  path: string;
  messageCount: number;
  updatedAt: string;
  preview: string;
};

export type ChatContextFile = {
  path: string;
  content: string;
};

export type FileChatRequest = {
  chatId?: string;
  path?: string;
  paths?: string[];
  userRequest: string;
  replayFromMessageId?: string;
};

export type FileChatResponse = {
  messages: FileChatMessage[];
};

export type GenerateEditResponse = {
  patchId: string;
  summary: string;
  oldContent: string;
  newContent: string;
  diffHtml: string;
};

export type ApplyPatchRequest = {
  patchId: string;
};

export type ApplyPatchResponse = {
  success: boolean;
};

export type RejectPatchRequest = {
  patchId: string;
};

export type AiEditResult = {
  summary: string;
  newContent: string | null;
};

export type PendingPatch = {
  patchId: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  createdAt: number;
};
