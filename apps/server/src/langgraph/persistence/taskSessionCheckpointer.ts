import fs from "node:fs/promises";
import path from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple
} from "@langchain/langgraph";
import { projectRuntimeDirectory } from "../../statePaths.js";
import { readJsonStateFile, requireStateFileVersion, writeJsonStateFile } from "../../stateFileStorage.js";

type EncodedValue = { type: string; data: string };
type StoredWrite = { taskId: string; channel: string; index: number; value: EncodedValue };
type PendingStoredWrite = StoredWrite & { namespace: string; checkpointId: string };
type StoredCheckpoint = {
  namespace: string;
  checkpointId: string;
  parentCheckpointId?: string;
  checkpoint: EncodedValue;
  metadata: EncodedValue;
  writes: StoredWrite[];
};
type ThreadCheckpointFile = {
  schemaVersion: 1;
  threadId: string;
  checkpoints: StoredCheckpoint[];
  pendingWrites: PendingStoredWrite[];
};

function requiredConfig(config: RunnableConfig, requireCheckpoint = false) {
  const threadId = config.configurable?.thread_id;
  const namespace = config.configurable?.checkpoint_ns ?? "";
  const checkpointId = config.configurable?.checkpoint_id;
  if (typeof threadId !== "string" || !threadId.trim()) throw new Error("LangGraph checkpoint 缺少 thread_id。");
  if (typeof namespace !== "string") throw new Error("LangGraph checkpoint_ns 必须是字符串。");
  if (requireCheckpoint && (typeof checkpointId !== "string" || !checkpointId)) {
    throw new Error("LangGraph pending writes 缺少 checkpoint_id。");
  }
  return { threadId, namespace, checkpointId: typeof checkpointId === "string" ? checkpointId : undefined };
}

function safeFileName(threadId: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(threadId)) throw new Error("LangGraph thread_id 包含不安全字符。");
  return `${threadId}.json`;
}

/**
 * 使用项目现有原子 JSON 存储实现的 LangGraph checkpointer。
 * 每个 thread 独立文件，避免与 TaskSession 互相覆盖；值通过 LangGraph serde 编码后再写入。
 */
export class TaskSessionCheckpointer extends BaseCheckpointSaver {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly directory = projectRuntimeDirectory("langgraph-checkpoints")) {
    super();
  }

  private filePath(threadId: string) {
    return path.join(this.directory, safeFileName(threadId));
  }

  private async encode(value: unknown): Promise<EncodedValue> {
    const [type, data] = await this.serde.dumpsTyped(value);
    return { type, data: Buffer.from(data).toString("base64") };
  }

  private decode(value: EncodedValue) {
    return this.serde.loadsTyped(value.type, Buffer.from(value.data, "base64"));
  }

  private async read(threadId: string): Promise<ThreadCheckpointFile> {
    const file = await readJsonStateFile<ThreadCheckpointFile>(this.filePath(threadId), {
      allowMissing: true,
      recover: true,
      validate: requireStateFileVersion(1)
    }) ?? { schemaVersion: 1, threadId, checkpoints: [], pendingWrites: [] };
    file.checkpoints = Array.isArray(file.checkpoints) ? file.checkpoints : [];
    file.pendingWrites = Array.isArray(file.pendingWrites) ? file.pendingWrites : [];
    return file;
  }

  private async mutate(threadId: string, update: (file: ThreadCheckpointFile) => Promise<void>) {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const file = await this.read(threadId);
      await update(file);
      await writeJsonStateFile(this.filePath(threadId), file);
    });
    this.queues.set(threadId, next);
    try {
      await next;
    } finally {
      if (this.queues.get(threadId) === next) this.queues.delete(threadId);
    }
  }

  private async tuple(threadId: string, stored: StoredCheckpoint): Promise<CheckpointTuple> {
    const checkpoint = await this.decode(stored.checkpoint) as Checkpoint;
    const metadata = await this.decode(stored.metadata) as CheckpointMetadata;
    const pendingWrites = await Promise.all(stored.writes.map(async (write) => [
      write.taskId,
      write.channel,
      await this.decode(write.value)
    ] as [string, string, unknown]));
    const config = { configurable: { thread_id: threadId, checkpoint_ns: stored.namespace, checkpoint_id: stored.checkpointId } };
    return {
      config,
      checkpoint,
      metadata,
      pendingWrites,
      ...(stored.parentCheckpointId
        ? { parentConfig: { configurable: { thread_id: threadId, checkpoint_ns: stored.namespace, checkpoint_id: stored.parentCheckpointId } } }
        : {})
    };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, namespace, checkpointId } = requiredConfig(config);
    const file = await this.read(threadId);
    const candidates = file.checkpoints.filter((item) => item.namespace === namespace);
    const stored = checkpointId
      ? candidates.find((item) => item.checkpointId === checkpointId)
      : candidates.sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))[0];
    return stored ? this.tuple(threadId, stored) : undefined;
  }

  async *list(config: RunnableConfig, options: { limit?: number; before?: RunnableConfig; filter?: Record<string, unknown> } = {}) {
    const { threadId, namespace, checkpointId } = requiredConfig(config);
    const before = options.before?.configurable?.checkpoint_id;
    const file = await this.read(threadId);
    let count = 0;
    for (const stored of file.checkpoints
      .filter((item) => item.namespace === namespace)
      .filter((item) => !checkpointId || item.checkpointId === checkpointId)
      .filter((item) => typeof before !== "string" || item.checkpointId < before)
      .sort((left, right) => right.checkpointId.localeCompare(left.checkpointId))) {
      const tuple = await this.tuple(threadId, stored);
      const metadata = tuple.metadata as Record<string, unknown> | undefined;
      if (options.filter && !Object.entries(options.filter).every(([key, value]) => metadata?.[key] === value)) continue;
      if (options.limit !== undefined && count >= options.limit) break;
      count += 1;
      yield tuple;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata): Promise<RunnableConfig> {
    const { threadId, namespace, checkpointId: parentCheckpointId } = requiredConfig(config);
    const [encodedCheckpoint, encodedMetadata] = await Promise.all([this.encode(checkpoint), this.encode(metadata)]);
    await this.mutate(threadId, async (file) => {
      const existing = file.checkpoints.find((item) => item.namespace === namespace && item.checkpointId === checkpoint.id);
      const pendingWrites = file.pendingWrites
        .filter((item) => item.namespace === namespace && item.checkpointId === checkpoint.id)
        .map(({ namespace: _namespace, checkpointId: _checkpointId, ...write }) => write);
      const next: StoredCheckpoint = {
        namespace,
        checkpointId: checkpoint.id,
        ...(parentCheckpointId ? { parentCheckpointId } : {}),
        checkpoint: encodedCheckpoint,
        metadata: encodedMetadata,
        writes: [...(existing?.writes ?? []), ...pendingWrites]
      };
      file.checkpoints = [...file.checkpoints.filter((item) => item !== existing), next];
      file.pendingWrites = file.pendingWrites.filter((item) => item.namespace !== namespace || item.checkpointId !== checkpoint.id);
    });
    return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } };
  }

  async putWrites(config: RunnableConfig, writes: Array<[string, unknown]>, taskId: string): Promise<void> {
    const { threadId, namespace, checkpointId } = requiredConfig(config, true);
    const encoded = await Promise.all(writes.map(async ([channel, value], index) => ({
      taskId,
      channel,
      index,
      value: await this.encode(value)
    })));
    await this.mutate(threadId, async (file) => {
      const stored = file.checkpoints.find((item) => item.namespace === namespace && item.checkpointId === checkpointId);
      for (const write of encoded) {
        if (stored) {
          if (stored.writes.some((item) => item.taskId === taskId && item.index === write.index)) continue;
          stored.writes.push(write);
        } else {
          if (file.pendingWrites.some((item) => item.namespace === namespace && item.checkpointId === checkpointId
            && item.taskId === taskId && item.index === write.index)) continue;
          file.pendingWrites.push({ namespace, checkpointId: checkpointId!, ...write });
        }
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await fs.rm(this.filePath(threadId), { force: true });
  }
}
