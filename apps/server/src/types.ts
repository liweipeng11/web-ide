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

export type FileChatRequest = {
  path: string;
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
