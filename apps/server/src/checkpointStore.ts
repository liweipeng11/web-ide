import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import { safeResolve } from "./fileTools.js";
import { legacyProjectRuntimeDirectory, projectRuntimeDirectory } from "./statePaths.js";
import type { Checkpoint, CheckpointSource, FilePatch } from "./types.js";

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
    id: taskId,
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
