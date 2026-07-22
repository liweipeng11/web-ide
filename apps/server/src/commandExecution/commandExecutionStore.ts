import fs from "node:fs/promises";
import path from "node:path";
import type { CommandExecution } from "./types.js";

type StoredDocument = { version: 1; executions: CommandExecution[] };

export type CommandExecutionStoreOptions = {
  stateFilePath: string;
  outputDirectory: string;
  now?: () => Date;
};

/** 将 execution 元数据和完整日志分开持久化，避免大输出膨胀 JSON 状态文件。 */
export class CommandExecutionStore {
  private readonly stateFilePath: string;
  private readonly outputDirectory: string;
  private readonly now: () => Date;
  private executions = new Map<string, CommandExecution>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: CommandExecutionStoreOptions) {
    this.stateFilePath = options.stateFilePath;
    this.outputDirectory = options.outputDirectory;
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<CommandExecution[]> {
    const raw = await fs.readFile(this.stateFilePath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!raw) return [];

    const document = JSON.parse(raw) as Partial<StoredDocument>;
    const executions = Array.isArray(document.executions) ? document.executions : [];
    let recovered = false;
    for (const execution of executions) {
      const copy = { ...execution, detectedUrls: [...(execution.detectedUrls || [])] };
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
    if (recovered) await this.persistMetadata();
    return [...this.executions.values()].map(cloneExecution);
  }

  async upsert(execution: CommandExecution) {
    this.executions.set(execution.id, cloneExecution(execution));
    await this.enqueue(() => this.persistMetadata());
  }

  async appendOutput(id: string, data: string) {
    if (!data) return;
    await this.enqueue(async () => {
      await fs.mkdir(this.outputDirectory, { recursive: true });
      await fs.appendFile(this.outputPath(id), data, "utf8");
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

  private outputPath(id: string) {
    // execution ID 由服务端生成；basename 仍用于防御未来导入数据中的路径穿越。
    return path.join(this.outputDirectory, `${path.basename(id)}.log`);
  }

  private enqueue(operation: () => Promise<void>) {
    this.writeQueue = this.writeQueue.then(operation, operation);
    return this.writeQueue;
  }

  private async persistMetadata() {
    await fs.mkdir(path.dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = `${this.stateFilePath}.tmp`;
    const document: StoredDocument = { version: 1, executions: [...this.executions.values()] };
    await fs.writeFile(temporaryPath, JSON.stringify(document, null, 2), "utf8");
    await fs.rename(temporaryPath, this.stateFilePath);
  }
}

function cloneExecution(execution: CommandExecution): CommandExecution {
  return { ...execution, detectedUrls: [...execution.detectedUrls] };
}
