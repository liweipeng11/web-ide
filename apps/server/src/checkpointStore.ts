import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { safeResolve } from "./fileTools.js";
import { legacyProjectRuntimeDirectory, listJsonFilesWithLegacyFallback, projectRuntimeDirectory } from "./statePaths.js";
import type { Checkpoint, CheckpointSource, FileEditResult, FilePatch } from "./types.js";

type CheckpointPatch = FilePatch & {
  status?: "create" | "modify" | "delete";
  path?: string;
};

export type CreateCheckpointOptions = {
  source?: CheckpointSource;
};

function checkpointDirectory() {
  return projectRuntimeDirectory("checkpoints");
}

function legacyCheckpointDirectory() {
  return legacyProjectRuntimeDirectory("checkpoints");
}

function sanitizeCheckpointFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_") || crypto.randomUUID();
}

function createCheckpointId(taskId: string) {
  // checkpoint 是真实落盘快照，同一个 patch 分批应用时也要产生独立记录。
  return `${sanitizeCheckpointFileName(taskId)}-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function checkpointPath(checkpointId: string) {
  return path.join(checkpointDirectory(), `${sanitizeCheckpointFileName(checkpointId)}.json`);
}

function legacyCheckpointPath(checkpointId: string) {
  return path.join(legacyCheckpointDirectory(), `${sanitizeCheckpointFileName(checkpointId)}.json`);
}

async function readFileIfExists(filePath: string) {
  const absolutePath = safeResolve(filePath);

  return fs
    .readFile(absolutePath, "utf8")
    .then((content) => ({ exists: true, content }))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return { exists: false, content: "" };
      }

      throw error;
    });
}

async function writeFileForRollback(filePath: string, content: string) {
  const absolutePath = safeResolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, "utf8");
}

async function writeBinaryFileForRollback(filePath: string, contentBase64: string) {
  const absolutePath = safeResolve(filePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, Buffer.from(contentBase64, "base64"));
}

async function deleteFileForRollback(filePath: string) {
  const absolutePath = safeResolve(filePath);
  await fs.rm(absolutePath, { force: true });
}

export async function createCheckpoint(taskId: string, patches: FilePatch[], options: CreateCheckpointOptions = {}): Promise<Checkpoint> {
  if (!taskId.trim()) {
    throw new HttpError(400, "taskId is required");
  }

  if (!patches.length) {
    throw new HttpError(400, "patches are required");
  }

  const checkpoint: Checkpoint = {
    id: createCheckpointId(taskId),
    taskId,
    createdAt: Date.now(),
    // 记录 checkpoint 的触发来源，便于任务历史中定位是哪次工具调用产生了可恢复点。
    source: options.source,
    files: await Promise.all(
      patches.map(async (patch) => {
        const change = patch as CheckpointPatch;
        const filePath = change.path || patch.filePath;
        const before = change.status === "create" ? { exists: false, content: "" } : await readFileIfExists(filePath);

        return {
          filePath,
          beforeContent: change.isBinary ? "" : before.content,
          afterContent: patch.newContent,
          beforeContentBase64: change.isBinary ? change.oldContentBase64 : undefined,
          afterContentBase64: change.isBinary ? change.newContentBase64 : undefined,
          isBinary: change.isBinary,
          beforeExists: before.exists,
          afterExists: change.status === "delete" ? false : true
        };
      })
    )
  };

  await fs.mkdir(checkpointDirectory(), { recursive: true });
  await fs.writeFile(checkpointPath(checkpoint.id), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");

  return checkpoint;
}

export async function createFileEditCheckpoint(taskId: string, result: FileEditResult, options: CreateCheckpointOptions = {}): Promise<Checkpoint> {
  if (!taskId.trim()) {
    throw new HttpError(400, "taskId is required");
  }

  const checkpoint: Checkpoint = {
    id: createCheckpointId(taskId),
    taskId,
    createdAt: Date.now(),
    // 文件编辑工具已经拿到了真实 before/after，不能再从磁盘读取 before，避免快照被写后状态污染。
    source: options.source,
    files: [
      {
        filePath: result.filePath,
        beforeContent: result.oldContent,
        afterContent: result.finalContent,
        beforeExists: result.beforeExists ?? true,
        afterExists: result.afterExists ?? true
      }
    ]
  };

  await fs.mkdir(checkpointDirectory(), { recursive: true });
  await fs.writeFile(checkpointPath(checkpoint.id), `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");

  return checkpoint;
}

export async function getCheckpoint(checkpointId: string): Promise<Checkpoint> {
  if (!checkpointId.trim()) {
    throw new HttpError(400, "checkpointId is required");
  }

  const content = await fs.readFile(checkpointPath(checkpointId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return fs.readFile(legacyCheckpointPath(checkpointId), "utf8").catch((legacyError: NodeJS.ErrnoException) => {
        if (legacyError.code === "ENOENT") {
          throw new HttpError(404, "Checkpoint not found");
        }
        throw legacyError;
      });
    }

    throw error;
  });

  return JSON.parse(content) as Checkpoint;
}

/**
 * 按副作用 action ID 查找文件 Checkpoint，供 LangGraph 在状态保存失败后核对真实落盘结果。
 * 这里只读取现有快照，不根据 Checkpoint 的存在直接推断写入成功。
 */
export async function findCheckpointsByActionId(actionId: string): Promise<Checkpoint[]> {
  const normalizedActionId = actionId.trim();
  if (!normalizedActionId) throw new HttpError(400, "actionId is required");

  const files = await listJsonFilesWithLegacyFallback(checkpointDirectory(), legacyCheckpointDirectory());
  const checkpoints = await Promise.all(files.map(async (filePath) => {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as Checkpoint;
  }));
  return checkpoints
    .filter((checkpoint) => checkpoint.source?.actionId === normalizedActionId)
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function rollbackCheckpoint(checkpointId: string): Promise<void> {
  const checkpoint = await getCheckpoint(checkpointId);

  for (const file of checkpoint.files) {
    const current = await readFileIfExists(file.filePath);

    if (file.afterExists === false) {
      if (current.exists) {
        throw new HttpError(409, `${file.filePath} has been recreated since checkpoint was created. Review it before rolling back.`);
      }
      continue;
    }

    if (!current.exists) {
      throw new HttpError(409, `${file.filePath} no longer exists`);
    }

    if (current.content !== file.afterContent) {
      throw new HttpError(409, `${file.filePath} has changed since checkpoint was created. Review it before rolling back.`);
    }
  }

  for (const file of checkpoint.files) {
    if (file.beforeExists === false) {
      await deleteFileForRollback(file.filePath);
    } else if (file.isBinary && file.beforeContentBase64) {
      await writeBinaryFileForRollback(file.filePath, file.beforeContentBase64);
    } else {
      await writeFileForRollback(file.filePath, file.beforeContent);
    }
  }
}
