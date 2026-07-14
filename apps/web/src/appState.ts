import type { AgentMode, AgentStep, Checkpoint, CommandPolicyResult, CommandResult, FileChatHistoryItem, FileChatMessage, FileTreeNode, GenerateEditResponse, ProjectRulesResponse, TaskSession, VerificationIssueCategory } from "./api";

export type OpenFileTab = {
  path: string;
  content: string;
  savedContent: string;
};

export type AppState = {
  selectedPath: string | null;
  fileContent: string;
  savedFileContent: string;
  openFiles: OpenFileTab[];
  userRequest: string;
  agentMode: AgentMode;
  chatId: string;
  chatMessages: FileChatMessage[];
  agentSteps: AgentStep[];
  currentTaskSessionId: string | null;
  taskSessions: TaskSession[];
  selectedTaskSession: TaskSession | null;
  chatHistories: FileChatHistoryItem[];
  chatContextPaths: string[];
  projectRules: ProjectRulesResponse | null;
  loading: boolean;
  streaming: boolean;
  error: string | null;
  patch: null | GenerateEditResponse;
  autoFix: AutoFixState | null;
  lastCheckpoint: Checkpoint | null;
  dismissedCheckpointId: string | null;
  workspaceRoot: string;
  workspaceInput: string;
  showIgnoredFiles: boolean;
};

export type AutoFixState = {
  command: string;
  attempts: number;
  maxAttempts: number;
  awaitingPatchId: string | null;
  lastFailureSummary: string;
  failureCategories: VerificationIssueCategory[];
};

export type CommandSuggestion = {
  command: string;
  reason?: string;
  risk?: string;
};

export function collectFilePaths(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node.path] : collectFilePaths(node.children || [])));
}

export function createChatId() {
  return `chat:${crypto.randomUUID()}`;
}

export function createClientErrorStep(message: string): AgentStep {
  return {
    id: `error:${Date.now()}:${crypto.randomUUID()}`,
    type: "error",
    message,
    createdAt: Date.now()
  };
}

export function createCommandAgentStep(command: string, status: NonNullable<Extract<AgentStep, { type: "command" }>["status"]>, policy?: CommandPolicyResult, result?: CommandResult | null): AgentStep {
  return {
    id: `command:${Date.now()}:${crypto.randomUUID()}`,
    type: "command",
    command,
    status,
    policy,
    result,
    createdAt: Date.now()
  };
}

export const initialState: AppState = {
  selectedPath: null,
  fileContent: "",
  savedFileContent: "",
  openFiles: [],
  userRequest: "",
  agentMode: "act",
  chatId: createChatId(),
  chatMessages: [],
  agentSteps: [],
  currentTaskSessionId: null,
  taskSessions: [],
  selectedTaskSession: null,
  chatHistories: [],
  chatContextPaths: [],
  projectRules: null,
  loading: false,
  streaming: false,
  error: null,
  patch: null,
  autoFix: null,
  lastCheckpoint: null,
  dismissedCheckpointId: null,
  workspaceRoot: "",
  workspaceInput: "",
  showIgnoredFiles: false
};
