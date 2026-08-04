import path from "node:path";
import pty, { type IPty } from "node-pty";
import type { Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { getWorkspaceRoot } from "./workspaceStore.js";
import { commandExecutionService, type CommandExecutionEvent, type CommandExecutionService } from "./commandExecution/index.js";

type TerminalClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    }
  | {
      type: "command.subscribe";
      id: string;
      cursor: number;
    }
  | {
      type: "command.stop" | "command.background";
      id: string;
    };

function getShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "bash";
  }

  return process.env.ComSpec || "cmd.exe";
}

function getShellLabel(shell: string) {
  if (process.platform !== "win32") {
    return path.basename(shell);
  }

  return path.basename(shell).replace(/\.exe$/i, "");
}

function getTerminalOptions(workspaceRoot: string) {
  return {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: workspaceRoot,
    env: {
      ...process.env,
      TERM: "xterm-256color"
    },
    // node-pty 1.1.x 的 ConPTY 清理流程会启动独立进程调用 AttachConsole；
    // 在部分 Windows 会话（例如从 PowerShell 启动的开发服务）中该调用会失败并使服务进程退出。
    // 回退到 winpty 可避免该不稳定的控制台枚举路径，终端输入输出功能不受影响。
    ...(process.platform === "win32" ? { useConpty: false } : {})
  };
}

function parseMessage(data: RawData): TerminalClientMessage | null {
  try {
    const text = typeof data === "string" ? data : data.toString("utf8");
    const parsed = JSON.parse(text) as TerminalClientMessage;

    if (parsed?.type === "input" && typeof parsed.data === "string") {
      return parsed;
    }

    if (parsed?.type === "resize" && Number.isFinite(parsed.cols) && Number.isFinite(parsed.rows)) {
      return {
        type: "resize",
        cols: Math.max(2, Math.floor(parsed.cols)),
        rows: Math.max(2, Math.floor(parsed.rows))
      };
    }

    if (parsed?.type === "command.subscribe" && typeof parsed.id === "string" && Number.isSafeInteger(parsed.cursor) && parsed.cursor >= 0) {
      return { type: "command.subscribe", id: parsed.id, cursor: parsed.cursor };
    }

    if ((parsed?.type === "command.stop" || parsed?.type === "command.background") && typeof parsed.id === "string") {
      return { type: parsed.type, id: parsed.id };
    }
  } catch {
    return null;
  }

  return null;
}

function writeJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function attachTerminalServer(server: Server, options: { executionService?: CommandExecutionService; createTerminal?: boolean } = {}) {
  const executionService = options.executionService ?? commandExecutionService;
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;

    if (pathname !== "/terminal") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit("connection", websocket, request);
    });
  });

  wss.on("connection", (socket) => {
    let terminal: IPty | null = null;
    const subscriptions = new Map<string, number>();

    // execution 事件与手工 PTY 消息使用不同 type 命名空间，避免两套协议相互误判。
    const unsubscribe = executionService.subscribe((event: CommandExecutionEvent) => {
      const id = event.type === "output" ? event.id : event.execution.id;
      const cursor = subscriptions.get(id);
      if (cursor === undefined) return;

      if (event.type === "output") {
        const eventEnd = event.cursor + event.data.length;
        if (eventEnd <= cursor) return;
        const data = cursor > event.cursor ? event.data.slice(cursor - event.cursor) : event.data;
        const nextCursor = Math.max(cursor, eventEnd);
        subscriptions.set(id, nextCursor);
        writeJson(socket, { type: "command.output", id, cursor: nextCursor - data.length, data });
        return;
      }

      writeJson(socket, { type: `command.${event.type}`, execution: event.execution });
    });

    try {
      if (options.createTerminal === false) {
        writeJson(socket, { type: "ready", cwd: getWorkspaceRoot() || process.cwd(), shell: "disabled" });
      } else {
        const workspaceRoot = getWorkspaceRoot() || process.cwd();
        const shell = getShell();

        terminal = pty.spawn(shell, [], getTerminalOptions(workspaceRoot));

        writeJson(socket, {
          type: "ready",
          cwd: workspaceRoot,
          shell: getShellLabel(shell)
        });

        terminal.onData((data) => {
          writeJson(socket, { type: "output", data });
        });

        terminal.onExit(({ exitCode, signal }) => {
          writeJson(socket, { type: "exit", exitCode, signal });
          socket.close();
        });
      }
    } catch (error) {
      writeJson(socket, {
        type: "error",
        error: error instanceof Error ? error.message : "Failed to start terminal"
      });
      socket.close();
      return;
    }

    socket.on("message", async (data) => {
      const message = parseMessage(data);
      if (!message) return;

      if (message.type === "input") {
        terminal?.write(message.data);
        return;
      }

      if (message.type === "resize") {
        terminal?.resize(message.cols, message.rows);
        return;
      }

      try {
        if (message.type === "command.subscribe") {
          const execution = await executionService.get(message.id);
          if (!execution) {
            // 使用稳定错误码通知前端清理已经删除或因服务重启失效的 execution。
            subscriptions.delete(message.id);
            writeJson(socket, { type: "command.error", id: message.id, code: "execution_not_found", message: "Command execution not found" });
            return;
          }
          subscriptions.set(message.id, message.cursor);
          const output = await executionService.readOutput(message.id, message.cursor);
          subscriptions.set(message.id, Math.max(subscriptions.get(message.id) || 0, output.nextCursor));
          writeJson(socket, { type: "command.started", execution });
          if (output.data) writeJson(socket, { type: "command.output", id: message.id, cursor: output.cursor, data: output.data });
          if (execution.readiness === "ready") writeJson(socket, { type: "command.ready", execution });
          if (["succeeded", "failed", "cancelled"].includes(execution.state)) writeJson(socket, { type: "command.finished", execution });
          return;
        }

        const execution = message.type === "command.stop"
          ? await executionService.stop(message.id)
          : await executionService.moveToBackground(message.id);
        writeJson(socket, { type: message.type === "command.stop" ? "command.finished" : "command.started", execution });
      } catch (error) {
        writeJson(socket, { type: "command.error", id: message.id, message: error instanceof Error ? error.message : "Command operation failed" });
      }
    });

    socket.on("close", () => {
      unsubscribe();
      if (!terminal) return;
      terminal.kill();
      terminal = null;
    });
  });
}
