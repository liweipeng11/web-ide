import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type StateFileErrorCode =
  | "STATE_FILE_NOT_FOUND"
  | "STATE_FILE_INVALID_JSON"
  | "STATE_FILE_ENCODING_ERROR"
  | "STATE_FILE_VERSION_UNSUPPORTED";

export class StateFileError extends Error {
  constructor(
    public readonly code: StateFileErrorCode,
    public readonly filePath: string,
    message: string,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "StateFileError";
  }
}

type ReadJsonStateOptions<T> = {
  allowMissing?: boolean;
  recover?: boolean;
  validate?: (value: unknown) => T;
  diagnosticPath?: string;
};

type WriteJsonStateOptions = {
  diagnosticPath?: string;
  rename?: (source: string, destination: string) => Promise<void>;
};

const writeQueues = new Map<string, Promise<unknown>>();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function diagnosticFilePath(filePath: string, explicitPath?: string) {
  return explicitPath ?? path.join(path.dirname(filePath), "state-storage-diagnostics.jsonl");
}

async function recordDiagnostic(
  filePath: string,
  code: StateFileErrorCode,
  message: string,
  options: { diagnosticPath?: string; recoveredFrom?: string } = {}
) {
  const target = diagnosticFilePath(filePath, options.diagnosticPath);
  const record = {
    timestamp: new Date().toISOString(),
    code,
    filePath,
    message,
    ...(options.recoveredFrom ? { recoveredFrom: options.recoveredFrom } : {})
  };
  await fs.mkdir(path.dirname(target), { recursive: true });
  // 诊断日志只记录路径和错误分类，不记录可能包含密钥或模型内容的状态正文。
  await fs.appendFile(target, `${JSON.stringify(record)}\n`, "utf8").catch(() => undefined);
}

function decodeUtf8(buffer: Uint8Array, filePath: string) {
  try {
    return utf8Decoder.decode(buffer);
  } catch (cause) {
    throw new StateFileError("STATE_FILE_ENCODING_ERROR", filePath, `状态文件不是有效 UTF-8：${filePath}`, { cause });
  }
}

function parseJson<T>(content: string, filePath: string, validate?: (value: unknown) => T): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (cause) {
    throw new StateFileError("STATE_FILE_INVALID_JSON", filePath, `状态文件不是有效 JSON：${filePath}`, { cause });
  }

  if (!validate) return value as T;
  try {
    return validate(value);
  } catch (cause) {
    if (cause instanceof StateFileError) throw cause;
    throw new StateFileError("STATE_FILE_VERSION_UNSUPPORTED", filePath, `状态文件版本不受支持：${filePath}`, { cause });
  }
}

async function readCandidate<T>(filePath: string, validate?: (value: unknown) => T) {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    if (error.code === "ENOENT") {
      throw new StateFileError("STATE_FILE_NOT_FOUND", filePath, `状态文件不存在：${filePath}`, { cause });
    }
    throw cause;
  }
  return parseJson<T>(decodeUtf8(buffer, filePath), filePath, validate);
}

async function recoveryCandidates(filePath: string) {
  const directory = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const temporaryFiles = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`.${baseName}.`) && entry.name.endsWith(".tmp"))
      .map(async (entry) => {
        const candidatePath = path.join(directory, entry.name);
        const stat = await fs.stat(candidatePath);
        return { candidatePath, modifiedAt: stat.mtimeMs };
      })
  );
  temporaryFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return [...temporaryFiles.map((item) => item.candidatePath), `${filePath}.bak`];
}

async function preserveCorruptFile(filePath: string) {
  const preservedPath = `${filePath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
  await fs.copyFile(filePath, preservedPath);
  return preservedPath;
}

export async function readJsonStateFile<T>(filePath: string, options: ReadJsonStateOptions<T> = {}): Promise<T | null> {
  try {
    return await readCandidate(filePath, options.validate);
  } catch (error) {
    if (!(error instanceof StateFileError)) throw error;
    if (error.code === "STATE_FILE_NOT_FOUND" && options.allowMissing) return null;
    await recordDiagnostic(filePath, error.code, error.message, options);
    if (!options.recover || error.code === "STATE_FILE_NOT_FOUND") throw error;

    for (const candidate of await recoveryCandidates(filePath)) {
      try {
        const recovered = await readCandidate(candidate, options.validate);
        const preservedPath = await preserveCorruptFile(filePath);
        await recordDiagnostic(filePath, error.code, `已从安全副本恢复，损坏文件保留于 ${preservedPath}`, {
          ...options,
          recoveredFrom: candidate
        });
        return recovered;
      } catch (candidateError) {
        if (candidateError instanceof StateFileError && candidateError.code === "STATE_FILE_NOT_FOUND") continue;
      }
    }
    throw error;
  }
}

function serializeJson(value: unknown, filePath: string) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (cause) {
    throw new StateFileError("STATE_FILE_INVALID_JSON", filePath, `状态无法序列化为 JSON：${filePath}`, { cause });
  }
  if (serialized === undefined) {
    throw new StateFileError("STATE_FILE_INVALID_JSON", filePath, `状态无法序列化为 JSON：${filePath}`);
  }
  // 写临时文件前先用标准解析器自检，避免自定义 toJSON 产生意外内容。
  parseJson(serialized, filePath);
  return `${serialized}\n`;
}

async function replaceFile(source: string, destination: string) {
  await fs.rename(source, destination).catch(async (error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
    await fs.rm(destination, { force: true });
    await fs.rename(source, destination);
  });
}

async function backupValidState(filePath: string) {
  const backupPath = `${filePath}.bak`;
  const temporaryBackupPath = `${backupPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.copyFile(filePath, temporaryBackupPath);
    await readCandidate(temporaryBackupPath);
    await replaceFile(temporaryBackupPath, backupPath);
  } finally {
    await fs.rm(temporaryBackupPath, { force: true }).catch(() => undefined);
  }
}

async function writeJsonStateFileNow(filePath: string, value: unknown, options: WriteJsonStateOptions) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const content = serializeJson(value, filePath);
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporaryPath, content, "utf8");
    // 测试和生产共用严格检查，成本仅发生在临时文件上，不会重复读取正式状态文件。
    await readCandidate(temporaryPath);
    const current = await readCandidate(filePath).catch((error) => error);
    if (!(current instanceof StateFileError) && current !== undefined) {
      // 备份本身也使用临时文件替换，崩溃时至少保留上一份完整备份。
      await backupValidState(filePath);
    } else if (current instanceof StateFileError && current.code !== "STATE_FILE_NOT_FOUND") {
      const preservedPath = await preserveCorruptFile(filePath);
      await recordDiagnostic(filePath, current.code, `写入前发现损坏状态，原文件保留于 ${preservedPath}`, options);
    }
    await (options.rename ?? replaceFile)(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writeJsonStateFile(filePath: string, value: unknown, options: WriteJsonStateOptions = {}) {
  const key = path.resolve(filePath);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeJsonStateFileNow(filePath, value, options));
  writeQueues.set(key, next);
  try {
    await next;
  } finally {
    if (writeQueues.get(key) === next) writeQueues.delete(key);
  }
}

export function requireStateFileVersion(expectedVersion: number) {
  return <T extends { schemaVersion?: unknown }>(value: unknown): T => {
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { schemaVersion?: unknown }).schemaVersion !== expectedVersion) {
      throw new Error(`expected schemaVersion ${expectedVersion}`);
    }
    return value as T;
  };
}
