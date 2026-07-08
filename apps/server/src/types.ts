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

export type ProjectRule = {
  path: string;
  scope: "global" | "project" | "legacy";
  source: "agents" | "cursor" | "windsurf" | "mini-ai";
  title: string;
  content: string;
  globs: string[];
  alwaysApply: boolean;
  active: boolean;
  truncated: boolean;
};

export type ProjectRulesResponse = {
  rules: ProjectRule[];
  combinedInstructions: string | null;
  supportedFiles: string[];
};

export type CommandResult = {
  command: string;
  chatId?: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  summary?: string;
  status?: "success" | "failed" | "running" | "timeout";
  detectedUrl?: string;
  outputTruncated?: boolean;
  startedAt: string;
  finishedAt: string;
};

export type CommandRiskLevel = "safe" | "confirm" | "blocked";

export type CommandPolicyResult = {
  level: CommandRiskLevel;
  reason: string;
};

export type RunCommandRequest = {
  command: string;
  chatId?: string;
  taskSessionId?: string;
  cwd?: string;
  confirmed?: boolean;
};

export type AutoValidationRequest = {
  command: string;
  selectedPath?: string | null;
  taskSessionId?: string | null;
  attempts?: number;
  maxAttempts?: number;
  confirmed?: boolean;
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
  approvedTaskSessionId?: string;
  agentMode?: AgentMode;
};

export type FileChatResponse = {
  messages: FileChatMessage[];
};

export type GenerateEditResponse = {
  taskSessionId?: string;
  patchId: string;
  summary: string;
  files: PatchFileChange[];
  commandsToRun?: string[];
  diffHtml: string;
  oldContent: string;
  newContent: string;
  agentSteps?: AgentStep[];
};

export type AutoValidationResponse = {
  status: "success" | "fix_generated" | "needs_confirmation" | "blocked" | "max_attempts_reached";
  command: string;
  attempts: number;
  maxAttempts: number;
  policy: CommandPolicyResult;
  result?: CommandResult;
  patch?: GenerateEditResponse;
  failureSummary?: string;
  agentSteps: AgentStep[];
};

export type AgentStep = {
  id: string;
  createdAt: number;
} & (
  | {
      type: "message";
      content: string;
    }
  | {
      type: "approval_request";
      actionId: string;
      actionType: "inspect_project" | "search_code" | "read_file" | "edit_files" | "run_command" | "apply_patch" | "write_file" | "delete_file" | "ask_user" | "tool_call";
      title: string;
      summary: string;
      riskLevel: "low" | "medium" | "high";
      status: "pending" | "approved" | "rejected" | "auto_approved";
      targets?: string[];
      command?: string;
      details?: unknown;
    }
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
    }
  | {
      type: "edit";
      files: string[];
    }
  | {
      type: "command";
      command: string;
      policy?: CommandPolicyResult;
      status?: "suggested" | "running" | "success" | "failed" | "blocked" | "cancelled";
      result?: CommandResult | null;
    }
  | {
      type: "checkpoint";
      checkpointId: string;
      files: string[];
      source?: CheckpointSource;
    }
  | {
      type: "error";
      message: string;
    }
);

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentMessageToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type AgentMessage = {
  id: string;
  role: AgentMessageRole;
  content: string | null;
  toolCallId?: string;
  toolCalls?: AgentMessageToolCall[];
  createdAt: number;
};

export type PendingAgentToolCall = {
  actionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  riskLevel: "low" | "medium" | "high";
  status: "pending";
  createdAt: number;
};

export type AgentMode = "plan" | "act";

export type TaskPlanItemStatus = "pending" | "in_progress" | "completed" | "blocked";

export type TaskPlanItem = {
  id: string;
  title: string;
  status: TaskPlanItemStatus;
  note?: string;
  evidence?: {
    stepIds: string[];
    files: string[];
    commands: string[];
  };
  createdAt: number;
  updatedAt: number;
};

export type TaskPlanRevisionTrigger = "user" | "agent" | "validation" | "system";

export type TaskPlanRevision = {
  id: string;
  trigger: TaskPlanRevisionTrigger;
  reason: string;
  beforeItems: {
    title: string;
    status: TaskPlanItemStatus;
  }[];
  afterItems: {
    title: string;
    status: TaskPlanItemStatus;
  }[];
  createdAt: number;
};

export type TaskPlanApproval = {
  required: boolean;
  status: "not_required" | "pending" | "approved";
  requestedAt?: number;
  approvedAt?: number;
};

// 任务会话状态会被连续 Agent 暂停/恢复复用，后续工具审批和用户追问都依赖这些状态。
export type TaskSessionStatus = "running" | "awaiting_approval" | "awaiting_user" | "paused" | "success" | "failed" | "cancelled" | "awaiting_replan";

export type TaskSession = {
  id: string;
  userGoal: string;
  agentMode?: AgentMode;
  chatId?: string;
  messageIds?: string[];
  status: TaskSessionStatus;
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  steps: AgentStep[];
  agentMessages?: AgentMessage[];
  pendingToolCall?: PendingAgentToolCall | null;
  planItems?: TaskPlanItem[];
  planRevisions?: TaskPlanRevision[];
  planApproval?: TaskPlanApproval;
  checkpointIds: string[];
  gitCommits?: {
    hash: string;
    message: string;
    files: string[];
    createdAt: number;
  }[];
  createdAt: number;
  updatedAt: number;
};

export type UpsertTaskPlanItemRequest = {
  id?: string;
  title: string;
  status?: TaskPlanItemStatus;
  note?: string;
};

export type UpdateTaskPlanItemRequest = {
  title?: string;
  status?: TaskPlanItemStatus;
  note?: string;
};

export type RewriteTaskPlanRequest = {
  instruction: string;
};

export type InterruptTaskPlanRequest = {
  instruction?: string;
};

export type ApprovalDecisionRequest = {
  decision: "approved" | "rejected";
};

export type UpdateAgentModeRequest = {
  mode: AgentMode;
};

export type ApplyPatchRequest = {
  patchId: string;
  filePath?: string;
};

export type ApplyPatchResponse = {
  success: boolean;
  checkpoint: Checkpoint;
};

export type RejectPatchRequest = {
  patchId: string;
  filePath?: string;
};

export type SearchReplaceEdit = {
  search: string;
  replace: string;
  replaceAll?: boolean;
};

export type FilePatch = {
  filePath: string;
  status?: "create" | "modify" | "delete";
  oldContent: string;
  newContent: string;
  oldContentBase64?: string;
  newContentBase64?: string;
  isBinary?: boolean;
  summary: string;
  edits?: SearchReplaceEdit[];
};

export type CheckpointSource = {
  taskSessionId?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  actionId?: string | null;
  patchId?: string | null;
  reason?: string | null;
};

export type EditScope = {
  allowedExistingFiles: string[];
  allowNewFiles: boolean;
  createdFileDirectories: string[];
};

export type Checkpoint = {
  id: string;
  taskId: string;
  createdAt: number;
  source?: CheckpointSource;
  files: {
    filePath: string;
    beforeContent: string;
    afterContent: string;
    beforeContentBase64?: string;
    afterContentBase64?: string;
    isBinary?: boolean;
    beforeExists?: boolean;
    afterExists?: boolean;
  }[];
};

export type RollbackCheckpointRequest = {
  checkpointId: string;
};

export type EditPlan = {
  summary: string;
  status?: "patch" | "needs_context" | "plan" | "blocked";
  patches: FilePatch[] | null;
  editScope?: EditScope;
  nextSearchKeywords?: string[];
  commandsToRun?: string[];
};

export type AiEditResult = EditPlan;

export type PatchFileChange = {
  path: string;
  filePath: string;
  status: "create" | "modify" | "delete";
  oldContent: string;
  newContent: string;
  oldContentBase64?: string;
  newContentBase64?: string;
  isBinary?: boolean;
  summary: string;
  diffHtml: string;
  editHunks?: EditHunk[];
};

export type EditHunkLine = {
  type: "context" | "add" | "remove";
  content: string;
};

export type EditHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: EditHunkLine[];
};

export type PendingPatch = {
  patchId: string;
  taskSessionId?: string;
  files: PatchFileChange[];
  commandsToRun?: string[];
  createdAt: number;
};
