import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { DocumentSyncRequest } from "../contracts/languageService.js";
import { JsonRpcConnection } from "./jsonRpcConnection.js";
import type { LspDiagnostic, LspServerCapabilities } from "./lspTypes.js";
import { discoverLanguageServer, languageFamily, type LanguageServerLaunch } from "./serverDiscovery.js";
import { languageIdForPath, normalizeRelativePath, toDocumentUri } from "./pathUtils.js";

export type PublishedDiagnostics = { uri: string; version?: number; diagnostics: LspDiagnostic[] };

export type ManagedLanguageServer = {
  family: NonNullable<ReturnType<typeof languageFamily>>;
  capabilities: LspServerCapabilities;
  request<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
};

type ServerState = {
  process: ChildProcessWithoutNullStreams;
  connection: JsonRpcConnection;
  capabilities: LspServerCapabilities;
  launch: LanguageServerLaunch;
  lastUsedAt: number;
  crashed: boolean;
};

type SyncedDocument = {
  uri: string;
  filePath: string;
  languageId: string;
  version: number;
  text: string;
};

export type LspProcessManagerOptions = {
  idleTimeoutMs?: number;
  discover?: typeof discoverLanguageServer;
  onDiagnostics?: (diagnostics: PublishedDiagnostics) => void;
};

/** 按工作区和语言族复用进程，并在崩溃后由下一次请求惰性重启。 */
export class LspProcessManager {
  private readonly states = new Map<string, Promise<ServerState>>();
  private readonly documents = new Map<string, Map<string, SyncedDocument>>();
  private readonly idleTimeoutMs: number;
  private readonly discover: typeof discoverLanguageServer;
  private readonly onDiagnostics?: (diagnostics: PublishedDiagnostics) => void;
  private readonly idleTimer: NodeJS.Timeout;

  constructor(options: LspProcessManagerOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.discover = options.discover ?? discoverLanguageServer;
    this.onDiagnostics = options.onDiagnostics;
    this.idleTimer = setInterval(() => void this.disposeIdle(), Math.min(this.idleTimeoutMs, 60_000));
    this.idleTimer.unref();
  }

  async getServer(workspaceRoot: string, languageId: string): Promise<ManagedLanguageServer | null> {
    const family = languageFamily(languageId);
    if (!family) return null;
    const key = `${workspaceRoot}\0${family}`;
    let statePromise = this.states.get(key);
    if (statePromise) {
      const existing = await statePromise.catch(() => null);
      if (existing && !existing.crashed) return this.toManaged(existing);
      this.states.delete(key);
    }

    statePromise = this.start(workspaceRoot, languageId, key);
    this.states.set(key, statePromise);
    try {
      return this.toManaged(await statePromise);
    } catch {
      this.states.delete(key);
      return null;
    }
  }

  async syncDocument(workspaceRoot: string, request: DocumentSyncRequest) {
    const filePath = normalizeRelativePath(workspaceRoot, request.filePath);
    const languageId = languageIdForPath(filePath);
    const uri = toDocumentUri(workspaceRoot, filePath);
    const textDocument = { uri };
    const family = languageFamily(languageId);
    if (!family) return false;
    const documentKey = `${workspaceRoot}\0${family}`;
    const documents = this.documents.get(documentKey) ?? new Map<string, SyncedDocument>();
    const previous = documents.get(uri);
    const server = request.action === "close" ? await this.getExistingServer(workspaceRoot, languageId) : await this.getServer(workspaceRoot, languageId);

    if (!server && request.action === "close") {
      documents.delete(uri);
      if (!documents.size) this.documents.delete(documentKey);
      return true;
    }
    if (!server) return false;

    if (request.action === "open") {
      server.notify("textDocument/didOpen", { textDocument: { ...textDocument, languageId, version: request.version, text: request.content ?? "" } });
    } else if (request.action === "change") {
      server.notify("textDocument/didChange", { textDocument: { ...textDocument, version: request.version }, contentChanges: [{ text: request.content ?? "" }] });
    } else if (request.action === "save") {
      server.notify("textDocument/didSave", { textDocument, text: request.content });
    } else {
      server.notify("textDocument/didClose", { textDocument });
    }

    if (request.action === "close") {
      documents.delete(uri);
      if (!documents.size) this.documents.delete(documentKey);
    } else {
      documents.set(uri, {
        uri,
        filePath,
        languageId,
        version: request.version,
        text: request.content ?? previous?.text ?? ""
      });
      this.documents.set(documentKey, documents);
    }
    return true;
  }

  async disposeWorkspace(workspaceRoot: string) {
    const matches = [...this.states.entries()].filter(([key]) => key.startsWith(`${workspaceRoot}\0`));
    await Promise.all(matches.map(async ([key, state]) => {
      this.states.delete(key);
      this.documents.delete(key);
      await this.stop(await state.catch(() => null));
    }));
    for (const key of [...this.documents.keys()]) if (key.startsWith(`${workspaceRoot}\0`)) this.documents.delete(key);
  }

  async disposeAll() {
    clearInterval(this.idleTimer);
    const states = [...this.states.values()];
    this.states.clear();
    this.documents.clear();
    await Promise.all(states.map(async (state) => this.stop(await state.catch(() => null))));
  }

  private async start(workspaceRoot: string, languageId: string, key: string) {
    const launch = await this.discover(workspaceRoot, languageId);
    if (!launch) throw new Error(`No language server configured for ${languageId}`);
    const child = spawn(launch.command, launch.args, {
      cwd: workspaceRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      // 仅记录受限长度且移除控制字符，不把完整项目输出写入日志。
      if (stderrBytes >= 8_192) return;
      const firstChunk = stderrBytes === 0;
      const remaining = Math.max(0, 8_192 - stderrBytes);
      stderrBytes += Math.min(chunk.length, remaining);
      if (process.env.LSP_DEBUG_LOGGING !== "1") {
        if (firstChunk) console.warn(`[lsp:${launch.family}] stderr received (${chunk.length} bytes, content hidden)`);
        return;
      }
      const message = this.redactLog(chunk.toString("utf8", 0, remaining).replace(/[\u0000-\u001f]+/g, " ")).trim();
      if (message) console.warn(`[lsp:${launch.family}] ${message}`);
    });

    const connection = new JsonRpcConnection(child.stdout, child.stdin, {
      onNotification: (method, params) => {
        if (method === "textDocument/publishDiagnostics") this.onDiagnostics?.(params as PublishedDiagnostics);
      },
      onRequest: (method, params) => {
        if (method === "workspace/configuration") {
          const count = Array.isArray((params as { items?: unknown[] } | null)?.items) ? (params as { items: unknown[] }).items.length : 0;
          return Array.from({ length: count }, () => null);
        }
        if (method === "workspace/workspaceFolders") return [{ uri: pathToFileURL(workspaceRoot).toString(), name: workspaceRoot.split(/[\\/]/).pop() || "workspace" }];
        if (method === "window/workDoneProgress/create") return null;
        return null;
      }
    });
    const state: ServerState = { process: child, connection, capabilities: {}, launch, lastUsedAt: Date.now(), crashed: false };
    child.once("exit", () => {
      state.crashed = true;
      connection.close(new Error(`Language server exited: ${launch.family}`));
      const active = this.states.get(key);
      void active?.then((candidate) => {
        if (candidate === state) this.states.delete(key);
      }).catch(() => this.states.delete(key));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      child.once("error", onError);
      child.once("spawn", () => {
        child.off("error", onError);
        resolve();
      });
    });

    try {
      const initializeResult = await connection.request<{ capabilities?: LspServerCapabilities }>("initialize", {
        processId: process.pid,
        clientInfo: { name: "mini-ai-web-editor", version: "0.1.0" },
        rootUri: pathToFileURL(workspaceRoot).toString(),
        workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).toString(), name: workspaceRoot.split(/[\\/]/).pop() || "workspace" }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          textDocument: { synchronization: { dynamicRegistration: false, didSave: true }, publishDiagnostics: { versionSupport: true }, hover: {}, definition: {}, references: {}, rename: {}, codeAction: {} }
        }
      });
      state.capabilities = initializeResult?.capabilities ?? {};
      connection.notify("initialized", {});
      await this.replayDocuments(workspaceRoot, launch.family, state);
      return state;
    } catch (error) {
      state.crashed = true;
      connection.close(error instanceof Error ? error : new Error("Language server initialization failed"));
      child.kill();
      throw error;
    }
  }

  private toManaged(state: ServerState): ManagedLanguageServer {
    state.lastUsedAt = Date.now();
    return {
      family: state.launch.family,
      capabilities: state.capabilities,
      request: (method, params) => {
        state.lastUsedAt = Date.now();
        return state.connection.request(method, params);
      },
      notify: (method, params) => {
        state.lastUsedAt = Date.now();
        state.connection.notify(method, params);
      }
    };
  }

  private async getExistingServer(workspaceRoot: string, languageId: string) {
    const family = languageFamily(languageId);
    if (!family) return null;
    const state = await this.states.get(`${workspaceRoot}\0${family}`)?.catch(() => null);
    return state && !state.crashed ? this.toManaged(state) : null;
  }

  private async disposeIdle() {
    for (const [key, promise] of [...this.states.entries()]) {
      const state = await promise.catch(() => null);
      if (!state || Date.now() - state.lastUsedAt < this.idleTimeoutMs) continue;
      this.states.delete(key);
      await this.stop(state);
    }
  }

  private async replayDocuments(workspaceRoot: string, family: LanguageServerLaunch["family"], state: ServerState) {
    const documents = this.documents.get(`${workspaceRoot}\0${family}`);
    if (!documents?.size) return;
    for (const document of documents.values()) {
      state.connection.notify("textDocument/didOpen", {
        textDocument: {
          uri: document.uri,
          languageId: document.languageId,
          version: document.version,
          text: document.text
        }
      });
    }
  }

  private redactLog(value: string) {
    return value
      .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, "$1<redacted>")
      .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>");
  }

  private async stop(state: ServerState | null) {
    if (!state || state.crashed) return;
    state.crashed = true;
    await state.connection.request("shutdown", null, 1_500).catch(() => undefined);
    const exited = new Promise<void>((resolve) => {
      if (state.process.exitCode !== null) resolve();
      else state.process.once("exit", () => resolve());
    });
    state.connection.notify("exit", null);
    const timer = setTimeout(() => {
      if (state.process.exitCode === null) state.process.kill();
    }, 1_000);
    timer.unref();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    clearTimeout(timer);
    state.connection.close();
  }
}
