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
  path?: string | null;
  userRequest: string;
};

export type SaveFileRequest = {
  path: string;
  content: string;
};

export type CodeSearchResult = {
  filePath: string;
  path: string;
  line: number;
  column: number;
  content: string;
  text: string;
  match: string;
};

export type SearchResult = {
  filePath: string;
  line: number;
  content: string;
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
  files: PatchFileChange[];
  diffHtml: string;
  oldContent: string;
  newContent: string;
  agentSteps?: Array<{
    id: string;
    type: "search" | "read";
    title: string;
    detail: string;
  }>;
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
  files: Array<{
    path: string;
    newContent: string;
  }> | null;
};

export type PatchFileChange = {
  path: string;
  status: "create" | "modify";
  oldContent: string;
  newContent: string;
  diffHtml: string;
};

export type PendingPatch = {
  patchId: string;
  files: PatchFileChange[];
  createdAt: number;
};
