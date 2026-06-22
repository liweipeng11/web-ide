export type GitFileChangeType = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted" | "unknown";

export type GitChangedFile = {
  path: string;
  originalPath?: string;
  status: GitFileChangeType;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
};

export type GitCommitInfo = {
  hash: string;
  message: string;
};

export type GitRemoteInfo = {
  name: string;
  url: string;
};

export type GitStatus = {
  isRepo: boolean;
  branch: string | null;
  root: string | null;
  hasChanges: boolean;
  changedFiles: GitChangedFile[];
  lastCommit: GitCommitInfo | null;
  remotes: GitRemoteInfo[];
};

export type CreateGitBranchRequest = {
  branchName: string;
  allowDirty?: boolean;
};

export type GenerateCommitMessageRequest = {
  taskSessionId?: string | null;
  files?: string[];
};

export type GitCommitRequest = {
  taskSessionId?: string | null;
  files?: string[];
  message: string;
};

export type GitCommitResult = {
  commit: GitCommitInfo;
  files: string[];
};

export type GitCommitRecord = GitCommitInfo & {
  files: string[];
  createdAt: number;
};
