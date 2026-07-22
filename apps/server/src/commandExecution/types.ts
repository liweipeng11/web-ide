export type CommandExecutionState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type CommandExecutionMode = "foreground" | "background" | "auto";

export type CommandReadiness = "pending" | "ready" | "not_applicable";

export type CommandFailureReason = "non_zero_exit" | "execution_timeout" | "spawn_error" | "output_limit" | "server_restart";

export type CommandExecution = {
  id: string;
  command: string;
  cwd: string;
  chatId?: string;
  taskSessionId?: string;
  mode: CommandExecutionMode;
  state: CommandExecutionState;
  readiness: CommandReadiness;
  readyUrl?: string;
  detectedUrls: string[];
  exitCode: number | null;
  signal?: string;
  pid?: number;
  waitTimedOut: boolean;
  outputTruncated: boolean;
  outputCursor: number;
  startedAt: string;
  readyAt?: string;
  finishedAt?: string;
  failureReason?: CommandFailureReason;
};

export type StartCommandInput = {
  command: string;
  cwd: string;
  chatId?: string;
  taskSessionId?: string;
  mode?: CommandExecutionMode;
  executionTimeoutMs?: number;
  readyPattern?: string;
};

export type WaitOptions = {
  until?: "finished" | "ready_or_finished";
  timeoutMs?: number;
  killOnTimeout?: boolean;
};

export type CommandExecutionFilter = {
  chatId?: string;
  taskSessionId?: string;
  state?: CommandExecutionState;
};

export type CommandOutputChunk = {
  id: string;
  cursor: number;
  nextCursor: number;
  data: string;
  truncated: boolean;
};

export type CommandExecutionEvent =
  | { type: "started"; execution: CommandExecution }
  | { type: "output"; id: string; cursor: number; data: string; stream: "stdout" | "stderr" }
  | { type: "ready"; execution: CommandExecution }
  | { type: "finished"; execution: CommandExecution };

export type CommandExecutionListener = (event: CommandExecutionEvent) => void;
