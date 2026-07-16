import type { Readable, Writable } from "node:stream";
import type { JsonRpcMessage } from "./lspTypes.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type JsonRpcConnectionOptions = {
  requestTimeoutMs?: number;
  onNotification?: (method: string, params: unknown) => void;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
};

/** 实现 LSP stdio 所需的 Content-Length 帧，严格限制消息体，避免异常服务端无限占用内存。 */
export class JsonRpcConnection {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly onNotification?: (method: string, params: unknown) => void;
  private readonly onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;

  constructor(private readonly readable: Readable, private readonly writable: Writable, options: JsonRpcConnectionOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    this.onNotification = options.onNotification;
    this.onRequest = options.onRequest;
    readable.on("data", (chunk: Buffer | string) => this.consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    readable.on("error", (error) => this.close(error));
    readable.on("close", () => this.close(new Error("Language server connection closed")));
  }

  request<T>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Language server connection is closed"));
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        reject(new Error(`Language server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  close(error = new Error("Language server connection closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private write(message: JsonRpcMessage) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.writable.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const maxMessageBytes = 10 * 1024 * 1024;

    while (this.buffer.length) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isInteger(length) || length < 0 || length > maxMessageBytes) {
        this.close(new Error("Invalid language server message length"));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);

      try {
        this.dispatch(JSON.parse(body) as JsonRpcMessage);
      } catch {
        this.close(new Error("Invalid JSON from language server"));
        return;
      }
    }
  }

  private dispatch(message: JsonRpcMessage) {
    if (message.method && message.id !== undefined) {
      void Promise.resolve(this.onRequest?.(message.method, message.params) ?? null).then(
        (result) => this.write({ jsonrpc: "2.0", id: message.id, result }),
        (error) => this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Client request failed" } })
      );
      return;
    }
    if (message.method && message.id === undefined) {
      this.onNotification?.(message.method, message.params);
      return;
    }
    if (message.id === undefined || typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(`Language server error ${message.error.code}: ${message.error.message}`));
    else pending.resolve(message.result);
  }
}
