import { randomUUID } from "node:crypto";
import { classifyCommand } from "./commandClassifier.js";
import { detectUrls, stripAnsi } from "./commandOutputParser.js";
import { detectCommandReadiness } from "./commandReadinessDetector.js";
import { createCommandOutputSummary } from "./commandOutputSummary.js";
import { detectCommandInteraction, sanitizeSensitiveOutput } from "./commandInteraction.js";
import { CommandExecutionMetrics } from "./commandExecutionMetrics.js";
import { CommandOutputBuffer } from "./commandOutputBuffer.js";
import type { CommandExecutionStore } from "./commandExecutionStore.js";
import { childProcessFactory, type CommandProcessFactory, type CommandProcessHandle, type CommandProcessStream } from "./commandProcess.js";
import { createCommandEnvironment, resolveShellLaunch } from "./shellCapability.js";
import type {
  CommandExecution,
  CommandExecutionEvent,
  CommandExecutionFilter,
  CommandExecutionListener,
  CommandOutputChunk,
  StartCommandInput,
  WaitOptions
} from "./types.js";

const terminalStates = new Set<CommandExecution["state"]>(["succeeded", "failed", "cancelled"]);

type ExecutionRecord = {
  execution: CommandExecution;
  process?: CommandProcessHandle;
  output: CommandOutputBuffer;
  stdout: CommandOutputBuffer;
  stderr: CommandOutputBuffer;
  timeout?: NodeJS.Timeout;
  readyPattern?: string;
};

export type CommandExecutionServiceOptions = {
  processFactory?: CommandProcessFactory;
  maxOutputLength?: number;
  now?: () => Date;
  createId?: () => string;
  store?: CommandExecutionStore;
  metrics?: CommandExecutionMetrics;
};

function cloneExecution(execution: CommandExecution): CommandExecution {
  return { ...execution, detectedUrls: [...execution.detectedUrls], shell: { ...execution.shell }, interaction: { ...execution.interaction } };
}

/** 服务端命令执行内核：统一维护进程生命周期、输出游标、就绪状态和完成事件。 */
export class CommandExecutionService {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<CommandExecutionListener>();
  private readonly processFactory: CommandProcessFactory;
  private readonly maxOutputLength: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly store?: CommandExecutionStore;
  private readonly metrics: CommandExecutionMetrics;
  private readonly hydration: Promise<void>;

  constructor(options: CommandExecutionServiceOptions = {}) {
    this.processFactory = options.processFactory ?? childProcessFactory;
    this.maxOutputLength = options.maxOutputLength ?? 80_000;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => `cmd-${randomUUID()}`);
    this.store = options.store;
    this.metrics = options.metrics ?? new CommandExecutionMetrics();
    this.hydration = this.hydrate();
  }

  async start(input: StartCommandInput): Promise<CommandExecution> {
    await this.hydration;
    const command = input.command.trim();
    if (!command) throw new Error("command is required");
    if (!input.cwd.trim()) throw new Error("cwd is required");
    if (input.executionTimeoutMs !== undefined && (!Number.isFinite(input.executionTimeoutMs) || input.executionTimeoutMs <= 0)) {
      throw new Error("executionTimeoutMs must be greater than zero");
    }
    if (input.readyPattern) detectCommandReadiness("", { readyPattern: input.readyPattern });

    const longRunning = classifyCommand(command).kind === "long_running";
    const requestedMode = input.mode ?? "auto";
    const mode = requestedMode === "auto" ? (longRunning ? "background" : "foreground") : requestedMode;
    const initiator = input.initiator ?? "user";
    const shell = resolveShellLaunch(command, { initiator });
    const execution: CommandExecution = {
      id: this.createId(),
      command,
      cwd: input.cwd,
      chatId: input.chatId,
      taskSessionId: input.taskSessionId,
      initiator,
      mode,
      shell: { name: shell.name, capability: shell.capability },
      state: "queued",
      readiness: mode === "background" ? "pending" : "not_applicable",
      detectedUrls: [],
      exitCode: null,
      waitTimedOut: false,
      outputTruncated: false,
      outputCursor: 0,
      interaction: { state: "none" },
      pinned: false,
      startedAt: this.now().toISOString()
    };
    const record: ExecutionRecord = {
      execution,
      output: new CommandOutputBuffer(this.maxOutputLength),
      stdout: new CommandOutputBuffer(this.maxOutputLength),
      stderr: new CommandOutputBuffer(this.maxOutputLength),
      readyPattern: input.readyPattern
    };
    this.records.set(execution.id, record);
    await this.persistExecution(execution);

    try {
      this.transition(record, "running");
      record.process = this.processFactory.start(
        { command, cwd: input.cwd, env: createCommandEnvironment({ initiator, ci: input.ci }), shell },
        {
          onData: (stream, data) => this.handleOutput(record, stream, data),
          onExit: (code, signal) => this.handleExit(record, code, signal),
          onError: () => this.finish(record, "failed", { failureReason: "spawn_error" })
        }
      );
      execution.pid = record.process.pid;
      await this.persistExecution(execution);
      this.emit({ type: "started", execution: cloneExecution(execution) });
      this.metrics.recordStarted();

      if (input.executionTimeoutMs !== undefined) {
        record.timeout = setTimeout(() => {
          if (terminalStates.has(execution.state)) return;
          this.finish(record, "failed", { failureReason: "execution_timeout" });
          void record.process?.kill();
        }, input.executionTimeoutMs);
      }
    } catch {
      this.finish(record, "failed", { failureReason: "spawn_error" });
    }

    return cloneExecution(execution);
  }

  async waitForState(id: string, options: WaitOptions = {}): Promise<CommandExecution> {
    await this.hydration;
    const record = this.requireRecord(id);
    const until = options.until ?? "finished";
    if (this.matchesWait(record.execution, until)) return cloneExecution(record.execution);

    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout | undefined;
      const listener: CommandExecutionListener = (event) => {
        if ((event.type !== "ready" && event.type !== "interaction" && event.type !== "finished") || event.execution.id !== id) return;
        if (!this.matchesWait(record.execution, until)) return;
        cleanup();
        resolve(cloneExecution(record.execution));
      };
      const cleanup = () => {
        this.listeners.delete(listener);
        if (timeout) clearTimeout(timeout);
      };
      this.listeners.add(listener);

      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cleanup();
          if (!terminalStates.has(record.execution.state)) {
            record.execution.waitTimedOut = true;
            this.metrics.recordWaitTimeout();
            void this.persistExecution(record.execution);
          }
          if (options.killOnTimeout && !terminalStates.has(record.execution.state)) this.stop(id);
          resolve(cloneExecution(record.execution));
        }, Math.max(0, options.timeoutMs));
      }
    });
  }

  async get(id: string) {
    await this.hydration;
    const execution = this.records.get(id)?.execution;
    return execution ? cloneExecution(execution) : null;
  }

  async list(filter: CommandExecutionFilter = {}) {
    await this.hydration;
    return [...this.records.values()]
      .map(({ execution }) => execution)
      .filter((execution) => !filter.chatId || execution.chatId === filter.chatId)
      .filter((execution) => !filter.taskSessionId || execution.taskSessionId === filter.taskSessionId)
      .filter((execution) => !filter.state || execution.state === filter.state)
      .map(cloneExecution);
  }

  async readOutput(id: string, cursor = 0): Promise<CommandOutputChunk> {
    await this.hydration;
    if (this.store) return this.store.readOutput(id, cursor);
    const snapshot = this.requireRecord(id).output.read(cursor);
    return { id, ...snapshot };
  }

  /** 兼容旧 CommandResult 时分别提供 stdout/stderr；新接口统一使用 readOutput。 */
  readCapturedOutput(id: string) {
    const record = this.requireRecord(id);
    return { stdout: record.stdout.tail(), stderr: record.stderr.tail() };
  }

  async moveToBackground(id: string) {
    await this.hydration;
    const record = this.requireRecord(id);
    record.execution.mode = "background";
    if (record.execution.state === "running" && record.execution.readiness === "not_applicable") {
      record.execution.readiness = "pending";
      const readiness = detectCommandReadiness(stripAnsi(record.output.tail()), { readyPattern: record.readyPattern });
      if (readiness.ready) {
        record.execution.readiness = "ready";
        record.execution.readyUrl = readiness.readyUrl;
        record.execution.readyAt = this.now().toISOString();
        this.metrics.recordReady(record.execution);
        this.emit({ type: "ready", execution: cloneExecution(record.execution) });
      }
    }
    await this.persistExecution(record.execution);
    return cloneExecution(record.execution);
  }

  async stop(id: string) {
    await this.hydration;
    const record = this.requireRecord(id);
    if (terminalStates.has(record.execution.state)) return cloneExecution(record.execution);

    // 先固化用户取消语义，随后到达的 exit/error 事件不会覆盖最终状态或重复发出完成事件。
    this.finish(record, "cancelled");
    await record.process?.kill();
    await this.persistExecution(record.execution);
    return cloneExecution(record.execution);
  }

  async getOutputSummary(id: string, maxLength = 4_000) {
    const execution = await this.get(id);
    if (!execution) throw new Error(`Command execution not found: ${id}`);
    const output = await this.readOutput(id, 0);
    return createCommandOutputSummary(execution, sanitizeSensitiveOutput(output.data), maxLength);
  }

  async setPinned(id: string, pinned: boolean) {
    await this.hydration;
    const record = this.requireRecord(id);
    record.execution.pinned = pinned;
    await this.persistExecution(record.execution);
    return cloneExecution(record.execution);
  }

  async getMetrics() {
    return this.metrics.snapshot(await this.list());
  }

  /** 应用退出时仅回收本实例创建且未固定的活动任务。 */
  async shutdown() {
    await this.hydration;
    const active = [...this.records.values()].filter(({ execution }) => !execution.pinned && !terminalStates.has(execution.state));
    await Promise.allSettled(active.map(({ execution }) => this.stop(execution.id)));
    await this.store?.flush();
  }

  async remove(id: string) {
    await this.hydration;
    const record = this.requireRecord(id);
    if (!terminalStates.has(record.execution.state)) throw new Error("Running command executions cannot be removed");
    this.records.delete(id);
    await this.store?.delete(id);
  }

  subscribe(listener: CommandExecutionListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleOutput(record: ExecutionRecord, stream: CommandProcessStream, data: string) {
    if (!data) return;
    const chunk = record.output.append(data);
    record[stream].append(data);
    record.execution.outputCursor = chunk.nextCursor;
    const wasTruncated = record.execution.outputTruncated;
    record.execution.outputTruncated = record.output.outputTruncated || record.stdout.outputTruncated || record.stderr.outputTruncated;
    if (!wasTruncated && record.execution.outputTruncated) this.metrics.recordOutputTruncated();
    void this.store?.appendOutput(record.execution.id, data).catch(() => undefined);

    const cleanOutput = stripAnsi(record.output.tail());
    if (record.execution.interaction.state === "none") {
      const interactionKind = detectCommandInteraction(cleanOutput);
      if (interactionKind) {
        record.execution.interaction = { state: "needs_input", kind: interactionKind, detectedAt: this.now().toISOString() };
        void this.persistExecution(record.execution);
        this.emit({ type: "interaction", execution: cloneExecution(record.execution) });
      }
    }
    record.execution.detectedUrls = detectUrls(cleanOutput);
    if (record.execution.state === "running" && record.execution.readiness === "pending") {
      const readiness = detectCommandReadiness(cleanOutput, { readyPattern: record.readyPattern });
      if (readiness.ready) {
        record.execution.readiness = "ready";
        record.execution.readyUrl = readiness.readyUrl;
        record.execution.readyAt = this.now().toISOString();
        this.metrics.recordReady(record.execution);
        void this.persistExecution(record.execution);
        this.emit({ type: "ready", execution: cloneExecution(record.execution) });
      }
    }

    void this.persistExecution(record.execution);

    this.emit({ type: "output", id: record.execution.id, cursor: chunk.cursor, data, stream });
  }

  private handleExit(record: ExecutionRecord, exitCode: number | null, signal?: string) {
    if (terminalStates.has(record.execution.state)) return;
    const state = exitCode === 0 ? "succeeded" : "failed";
    this.finish(record, state, {
      exitCode,
      signal,
      failureReason: state === "failed" ? "non_zero_exit" : undefined
    });
  }

  private finish(record: ExecutionRecord, state: "succeeded" | "failed" | "cancelled", details: Partial<CommandExecution> = {}) {
    if (terminalStates.has(record.execution.state)) return;
    clearTimeout(record.timeout);
    this.transition(record, state);
    Object.assign(record.execution, details, { finishedAt: this.now().toISOString() });
    this.metrics.recordFinished(record.execution);
    void this.persistExecution(record.execution);
    this.emit({ type: "finished", execution: cloneExecution(record.execution) });
  }

  private transition(record: ExecutionRecord, nextState: CommandExecution["state"]) {
    const current = record.execution.state;
    const allowed =
      (current === "queued" && (nextState === "running" || nextState === "cancelled")) ||
      (current === "running" && terminalStates.has(nextState));
    if (!allowed) throw new Error(`Invalid command execution transition: ${current} -> ${nextState}`);
    record.execution.state = nextState;
  }

  private matchesWait(execution: CommandExecution, until: NonNullable<WaitOptions["until"]>) {
    return terminalStates.has(execution.state) || execution.interaction.state === "needs_input" || (until === "ready_or_finished" && execution.readiness === "ready");
  }

  private requireRecord(id: string) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Command execution not found: ${id}`);
    return record;
  }

  private emit(event: CommandExecutionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private async hydrate() {
    if (!this.store) return;
    const executions = await this.store.load();
    for (const execution of executions) {
      const normalized: CommandExecution = {
        ...execution,
        initiator: execution.initiator || "user",
        shell: execution.shell || { name: "unknown", capability: "none" },
        interaction: execution.interaction || { state: "none" },
        pinned: execution.pinned === true
      };
      this.records.set(execution.id, {
        execution: normalized,
        output: new CommandOutputBuffer(this.maxOutputLength),
        stdout: new CommandOutputBuffer(this.maxOutputLength),
        stderr: new CommandOutputBuffer(this.maxOutputLength)
      });
    }
  }

  private async persistExecution(execution: CommandExecution) {
    await this.store?.upsert(cloneExecution(execution));
  }
}
