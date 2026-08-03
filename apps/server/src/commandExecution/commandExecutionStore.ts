import fs from "node:fs/promises";
import path from "node:path";
import { readJsonStateFile, writeJsonStateFile } from "../stateFileStorage.js";
import type { CommandExecution } from "./types.js";

type StoredDocument = { version: 1; executions: CommandExecution[] };

export type CommandExecutionStoreOptions = {
  stateFilePath: string;
  outputDirectory: string;
  now?: () => Date;
  retentionLimit?: number;
  retentionDays?: number;
  maxLogFileBytes?: number;
  maxWorkspaceLogBytes?: number;
};

/** 将 execution 元数据和完整日志分开持久化，避免大输出膨胀 JSON 状态文件。 */
export class CommandExecutionStore {
  private readonly stateFilePath: string;
  private readonly outputDirectory: string;
  private readonly now: () => Date;
  private readonly retentionLimit: number;
  private readonly retentionMs: number;
  private readonly maxLogFileBytes: number;
  private readonly maxWorkspaceLogBytes: number;
  private executions = new Map<string, CommandExecution>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: CommandExecutionStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.outputDirectory = options.outputDirectory;
    this.now = options.now ?? (() => new Date());
    this.retentionLimit = options.retentionLimit ?? 100;
    this.retentionMs = (options.retentionDays ?? 30) * 24 * 60 * 60 * 1_000;
    this.maxLogFileBytes = options.maxLogFileBytes ?? 5 * 1024 * 1024;
    this.maxWorkspaceLogBytes = options.maxWorkspaceLogBytes ?? 50 * 1024 * 1024;
  }

  async load(): Promise<CommandExecution[]> {
    const document = await readJsonStateFile<StoredDocument>(this.stateFilePath, {
      allowMissing: true,
      recover: true,
      validate(value) {
        const candidate = value as Partial<StoredDocument> | null;
        if (!candidate || candidate.version !== 1 || !Array.isArray(candidate.executions)) {
          throw new Error("unsupported command execution state");
        }
        return candidate as StoredDocument;
      }
    });
    if (!document) return [];
    const executions = document.executions;
    let recovered = false;
    for (const execution of executions) {
      const copy = normalizeExecution(execution);
      if (copy.state === "queued" || copy.state === "running") {
        // 服务重启后无法重新绑定旧子进程，必须明确标记失联，不能伪装成仍在运行。
        copy.state = "failed";
        copy.failureReason = "server_restart";
        copy.exitCode = null;
        copy.pid = undefined;
        copy.finishedAt = this.now().toISOString();
        recovered = true;
      }
      this.executions.set(copy.id, copy);
    }
    const removed = await this.cleanup();
    if (recovered && removed === 0) await this.persistMetadata();
    return [...this.executions.values()].map(cloneExecution);
  }

  async upsert(execution: CommandExecution) {
    this.executions.set(execution.id, cloneExecution(execution));
    await this.enqueue(async () => {
      const removedIds = await this.pruneMetadata();
      for (const id of removedIds) await fs.rm(this.outputPath(id), { force: true });
      await this.persistMetadata();
    });
  }

  async appendOutput(id: string, data: string) {
    if (!data) return;
    await this.enqueue(async () => {
      await fs.mkdir(this.outputDirectory, { recursive: true });
      const outputPath = this.outputPath(id);
      const size = await fs.stat(outputPath).then((stat) => stat.size).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? 0 : Promise.reject(error));
      const remaining = Math.max(0, this.maxLogFileBytes - size);
      if (remaining === 0) return;
      // 以字节上限截取，避免多字节字符让单文件突破配置值。
      const chunk = Buffer.from(data, "utf8").subarray(0, remaining);
      await fs.appendFile(outputPath, chunk);
    });
  }

  async readOutput(id: string, cursor = 0) {
    await this.writeQueue;
    const data = await fs.readFile(this.outputPath(id), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const safeCursor = Math.min(Math.max(0, cursor), data.length);
    return { id, cursor: safeCursor, nextCursor: data.length, data: data.slice(safeCursor), truncated: cursor > data.length };
  }

  async delete(id: string) {
    this.executions.delete(id);
    await this.enqueue(async () => {
      await this.persistMetadata();
      await fs.rm(this.outputPath(id), { force: true });
    });
  }

  async flush() {
    await this.writeQueue;
  }

  /** 清理结束历史和日志预算；活动任务、固定任务始终保留。 */
  async cleanup() {
    return this.enqueue(async () => {
      const removedIds = await this.pruneMetadata();
      for (const id of removedIds) await fs.rm(this.outputPath(id), { force: true });
      await this.enforceWorkspaceLogBudget();
      if (removedIds.length > 0) await this.persistMetadata();
      return removedIds.length;
    });
  }

  private outputPath(id: string) {
    // execution ID 由服务端生成；basename 仍用于防御未来导入数据中的路径穿越。
    return path.join(this.outputDirectory, `${path.basename(id)}.log`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async pruneMetadata() {
    const cutoff = this.now().getTime() - this.retentionMs;
    const terminal = [...this.executions.values()]
      .filter((item) => item.state !== "queued" && item.state !== "running" && !item.pinned)
      .sort((left, right) => Date.parse(right.finishedAt || right.startedAt) - Date.parse(left.finishedAt || left.startedAt));
    const removedIds = terminal
      .filter((item, index) => index >= this.retentionLimit || Date.parse(item.finishedAt || item.startedAt) < cutoff)
      .map((item) => item.id);
    for (const id of removedIds) this.executions.delete(id);
    return removedIds;
  }

  private async enforceWorkspaceLogBudget() {
    const files = await fs.readdir(this.outputDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const entries = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".log")).map(async (entry) => {
      const filePath = path.join(this.outputDirectory, entry.name);
      const stat = await fs.stat(filePath);
      return { filePath, size: stat.size, mtimeMs: stat.mtimeMs, id: entry.name.slice(0, -4) };
    }));
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      if (total <= this.maxWorkspaceLogBytes) break;
      const execution = this.executions.get(entry.id);
      if (execution?.pinned || execution?.state === "queued" || execution?.state === "running") continue;
      await fs.rm(entry.filePath, { force: true });
      total -= entry.size;
    }
  }

  private async persistMetadata() {
    const document: StoredDocument = { version: 1, executions: [...this.executions.values()] };
    await writeJsonStateFile(this.stateFilePath, document);
  }
}

function cloneExecution(execution: CommandExecution): CommandExecution {
  return { ...execution, detectedUrls: [...execution.detectedUrls], shell: { ...execution.shell }, interaction: { ...execution.interaction } };
}

function normalizeExecution(execution: CommandExecution): CommandExecution {
  return cloneExecution({
    ...execution,
    initiator: execution.initiator || "user",
    shell: execution.shell || { name: "unknown", capability: "none" },
    interaction: execution.interaction || { state: "none" },
    pinned: execution.pinned === true,
    detectedUrls: execution.detectedUrls || []
  });
}
