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

export type GenerateEditResponse = {
  taskSessionId?: string;
  patchId: string;
  summary: string;
  files: PatchFileChange[];
  commandsToRun?: string[];
  oldContent: string;
  newContent: string;
  diffHtml: string;
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

export type Checkpoint = {
  id: string;
  taskId: string;
  createdAt: number;
  files: {
    filePath: string;
    beforeContent: string;
    afterContent: string;
    beforeExists?: boolean;
  }[];
};

export type PatchFileChange = {
  path: string;
  filePath: string;
  status: "create" | "modify";
  oldContent: string;
  newContent: string;
  summary: string;
  diffHtml: string;
};

export type FileChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
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
      type: "error";
      message: string;
    }
);

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

export type TaskSession = {
  id: string;
  userGoal: string;
  chatId?: string;
  messageIds?: string[];
  status: "running" | "success" | "failed" | "cancelled";
  filesRead: string[];
  filesChanged: string[];
  commandsRun: string[];
  steps: AgentStep[];
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

export type FileChatHistoryItem = {
  path: string;
  messageCount: number;
  updatedAt: string;
  preview: string;
};

export type FileChatResponse = {
  messages: FileChatMessage[];
  taskSessionId?: string;
};

export type FileChatHistoriesResponse = {
  histories: FileChatHistoryItem[];
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

export type CodeSearchResponse = {
  results: CodeSearchResult[];
};

export type ProjectCommand = {
  name: string;
  command: string;
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

export type CommandsResponse = {
  commands: ProjectCommand[];
  results: CommandResult[];
};

export type TaskSessionsResponse = {
  sessions: TaskSession[];
};

export type ResumeTaskSessionChatResponse = {
  session: TaskSession;
  chatId: string;
  messages: FileChatMessage[];
};

export type FileChatStreamEvent =
  | { event: "user"; data: { message: FileChatMessage } }
  | { event: "assistant_start"; data: { message: FileChatMessage } }
  | { event: "chat"; data: { chatId: string; historyCount: number; taskSessionId?: string } }
  | { event: "task_session"; data: { session: TaskSession } }
  | { event: "agent_step"; data: { step: AgentStep } }
  | { event: "patch"; data: { patch: GenerateEditResponse } }
  | { event: "delta"; data: { id: string; delta: string } }
  | { event: "done"; data: { messages: FileChatMessage[] } }
  | { event: "error"; data: { error: string } };

export type GenerateEditStreamEvent =
  | { event: "task_session"; data: { session: TaskSession } }
  | { event: "agent_step"; data: { step: AgentStep } }
  | { event: "done"; data: { patch: GenerateEditResponse } }
  | { event: "error"; data: { error: string } };

export type WorkspaceResponse = {
  workspaceRoot: string | null;
};

export type PickWorkspaceResponse = WorkspaceResponse & {
  cancelled: boolean;
};

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers
    },
    ...options
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(data?.error || data?.summary || "请求失败");
  }

  return data as T;
}

export function fetchFiles(dir = "", includeIgnored = false) {
  return request<FileTreeNode[]>(`/api/files?dir=${encodeURIComponent(dir)}&includeIgnored=${includeIgnored ? "true" : "false"}`);
}

export function fetchWorkspace() {
  return request<WorkspaceResponse>("/api/workspace");
}

export function openWorkspace(workspaceRoot: string) {
  return request<WorkspaceResponse>("/api/workspace/open", {
    method: "POST",
    body: JSON.stringify({ workspaceRoot })
  });
}

export function pickWorkspace() {
  return request<PickWorkspaceResponse>("/api/workspace/pick", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function fetchFile(path: string, includeIgnored = false) {
  return request<ReadFileResponse>(`/api/file?path=${encodeURIComponent(path)}&includeIgnored=${includeIgnored ? "true" : "false"}`);
}

export function searchCode(query: string) {
  return request<CodeSearchResponse>(`/api/search?q=${encodeURIComponent(query)}`);
}

export function fetchProjectCommands() {
  return request<CommandsResponse>("/api/commands");
}

export function fetchProjectRules(paths: string[] = []) {
  const query = paths.map((path) => `path=${encodeURIComponent(path)}`).join("&");
  return request<ProjectRulesResponse>(`/api/project-rules${query ? `?${query}` : ""}`);
}

export function fetchCommandPolicy(command: string) {
  return request<{ policy: CommandPolicyResult }>("/api/commands/policy", {
    method: "POST",
    body: JSON.stringify({ command })
  });
}

export function runProjectCommand(command: string, cwd?: string, chatId?: string, confirmed = false, taskSessionId?: string | null) {
  return request<{ result: CommandResult }>("/api/commands/run", {
    method: "POST",
    body: JSON.stringify({ command, cwd, chatId, confirmed, taskSessionId })
  });
}

export function validateAndFix(command: string, options: { selectedPath?: string | null; taskSessionId?: string | null; attempts?: number; maxAttempts?: number; confirmed?: boolean } = {}) {
  return request<AutoValidationResponse>("/api/ai/validate-and-fix", {
    method: "POST",
    body: JSON.stringify({
      command,
      ...options
    })
  });
}

export function saveFile(path: string, content: string) {
  return request<{ success: boolean; path: string }>("/api/file", {
    method: "POST",
    body: JSON.stringify({ path, content })
  });
}

export function generateEdit(path: string | null, userRequest: string) {
  return request<GenerateEditResponse>("/api/ai/generate-edit", {
    method: "POST",
    body: JSON.stringify({ path, userRequest })
  });
}

export async function streamGenerateEdit(path: string | null, userRequest: string, onEvent: (event: GenerateEditStreamEvent) => void, signal?: AbortSignal) {
  const response = await fetch("/api/ai/generate-edit/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({ path, userRequest })
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `请求失败，状态码 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";

    for (const packet of packets) {
      const event = packet.match(/^event:\s*(.+)$/m)?.[1]?.trim() as GenerateEditStreamEvent["event"] | undefined;
      const dataLine = packet.match(/^data:\s*(.+)$/m)?.[1];

      if (!event || !dataLine) continue;

      onEvent({ event, data: JSON.parse(dataLine) } as GenerateEditStreamEvent);
    }
  }
}

export function fetchFileChat(chatId?: string) {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
  return request<FileChatResponse>(`/api/ai/file-chat${query}`);
}

export function fetchFileChatHistories() {
  return request<FileChatHistoriesResponse>("/api/ai/file-chat/histories");
}

export function fetchTaskSessions() {
  return request<TaskSessionsResponse>("/api/task-sessions");
}

export function fetchTaskSession(taskSessionId: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}`);
}

export function resumeTaskSessionChat(taskSessionId: string) {
  return request<ResumeTaskSessionChatResponse>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/resume-chat`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function deleteTaskSession(taskSessionId: string) {
  return request<TaskSessionsResponse>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}`, {
    method: "DELETE"
  });
}

export function recordTaskSessionCommand(taskSessionId: string, command: string, result?: CommandResult | null) {
  return request<{ success: boolean }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ command, result })
  });
}

export function createTaskPlanItem(taskSessionId: string, title: string, status: TaskPlanItemStatus = "pending", note = "") {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items`, {
    method: "POST",
    body: JSON.stringify({ title, status, note })
  });
}

export function updateTaskPlanItem(taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items/${encodeURIComponent(planItemId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates)
  });
}

export function deleteTaskPlanItem(taskSessionId: string, planItemId: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items/${encodeURIComponent(planItemId)}`, {
    method: "DELETE"
  });
}

export function rewriteTaskPlan(taskSessionId: string, instruction: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan-items/rewrite`, {
    method: "POST",
    body: JSON.stringify({ instruction })
  });
}

export function approveTaskPlan(taskSessionId: string) {
  return request<{ session: TaskSession }>(`/api/task-sessions/${encodeURIComponent(taskSessionId)}/plan/approve`, {
    method: "POST",
    body: JSON.stringify({})
  });
}

export function deleteFileChatHistory(path: string) {
  return request<FileChatHistoriesResponse>(`/api/ai/file-chat/histories?path=${encodeURIComponent(path)}`, {
    method: "DELETE"
  });
}

export function sendFileChatMessage(userRequest: string, paths: string[] = [], chatId?: string) {
  return request<FileChatResponse>("/api/ai/file-chat", {
    method: "POST",
    body: JSON.stringify({ chatId, paths, userRequest })
  });
}

export async function streamFileChatMessage(userRequest: string, paths: string[], chatId: string, onEvent: (event: FileChatStreamEvent) => void, signal?: AbortSignal, replayFromMessageId?: string, path?: string | null, approvedTaskSessionId?: string) {
  const response = await fetch("/api/ai/file-chat/stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    signal,
    body: JSON.stringify({ chatId, path, paths, userRequest, replayFromMessageId, approvedTaskSessionId })
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `请求失败，状态码 ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const packets = buffer.split("\n\n");
    buffer = packets.pop() || "";

    for (const packet of packets) {
      const event = packet.match(/^event:\s*(.+)$/m)?.[1]?.trim() as FileChatStreamEvent["event"] | undefined;
      const dataLine = packet.match(/^data:\s*(.+)$/m)?.[1];

      if (!event || !dataLine) continue;

      onEvent({ event, data: JSON.parse(dataLine) } as FileChatStreamEvent);
    }
  }
}

export function clearFileChat(chatId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat?chatId=${encodeURIComponent(chatId)}`, {
    method: "DELETE"
  });
}

export function deleteFileChatMessage(chatId: string, messageId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat/messages/${encodeURIComponent(messageId)}?chatId=${encodeURIComponent(chatId)}`, {
    method: "DELETE"
  });
}

export function branchFileChatMessage(chatId: string, messageId: string) {
  return request<FileChatResponse>(`/api/ai/file-chat/messages/${encodeURIComponent(messageId)}/branch`, {
    method: "POST",
    body: JSON.stringify({ chatId })
  });
}

export function applyPatch(patchId: string, filePath?: string) {
  return request<{ success: boolean; checkpoint: Checkpoint }>("/api/patch/apply", {
    method: "POST",
    body: JSON.stringify({ patchId, filePath })
  });
}

export function fetchCheckpoint(checkpointId: string) {
  return request<{ checkpoint: Checkpoint }>(`/api/checkpoints/${encodeURIComponent(checkpointId)}`);
}

export function rollbackCheckpoint(checkpointId: string) {
  return request<{ success: boolean }>("/api/checkpoints/rollback", {
    method: "POST",
    body: JSON.stringify({ checkpointId })
  });
}

export function rejectPatch(patchId: string, filePath?: string) {
  return request<{ success: boolean }>("/api/patch/reject", {
    method: "POST",
    body: JSON.stringify({ patchId, filePath })
  });
}
