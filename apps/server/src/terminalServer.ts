import os from "node:os";
import pty, { type IPty } from "node-pty";
import type { Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { getWorkspaceRoot } from "./workspaceStore.js";

type TerminalClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    };

function getShell() {
  if (process.platform !== "win32") {
    return process.env.SHELL || "bash";
  }

  return process.env.PSModulePath ? "powershell.exe" : process.env.ComSpec || "cmd.exe";
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

export function attachTerminalServer(server: Server) {
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

    try {
      const workspaceRoot = getWorkspaceRoot() || process.cwd();
      const shell = getShell();

      terminal = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: workspaceRoot,
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      });

      writeJson(socket, {
        type: "ready",
        cwd: workspaceRoot,
        shell: os.platform() === "win32" ? shell.replace(/\.exe$/i, "") : shell
      });

      terminal.onData((data) => {
        writeJson(socket, { type: "output", data });
      });

      terminal.onExit(({ exitCode, signal }) => {
        writeJson(socket, { type: "exit", exitCode, signal });
        socket.close();
      });
    } catch (error) {
      writeJson(socket, {
        type: "error",
        error: error instanceof Error ? error.message : "Failed to start terminal"
      });
      socket.close();
      return;
    }

    socket.on("message", (data) => {
      if (!terminal) return;

      const message = parseMessage(data);
      if (!message) return;

      if (message.type === "input") {
        terminal.write(message.data);
        return;
      }

      terminal.resize(message.cols, message.rows);
    });

    socket.on("close", () => {
      if (!terminal) return;
      terminal.kill();
      terminal = null;
    });
  });
}
