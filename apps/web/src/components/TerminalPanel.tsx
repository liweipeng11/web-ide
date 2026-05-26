import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import Icon from "./Icon";

type Props = {
  workspaceRoot: string;
  height: number;
  onClose: () => void;
  onStartResize: (event: PointerEvent<HTMLDivElement>) => void;
};

type ServerMessage =
  | { type: "ready"; cwd: string; shell: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; error: string };

function getTerminalUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal`;
}

export default function TerminalPanel({ workspaceRoot, height, onClose, onStartResize }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">("closed");

  useEffect(() => {
    if (!containerRef.current || !workspaceRoot) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      theme: {
        background: "#111827",
        foreground: "#e5edf7",
        cursor: "#f8fafc",
        selectionBackground: "#334155"
      }
    });
    const fitAddon = new FitAddon();
    const socket = new WebSocket(getTerminalUrl());

    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminal.focus();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    socketRef.current = socket;
    setStatus("connecting");

    const fit = () => {
      fitAddon.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };

    const fitSoon = () => window.setTimeout(fit, 0);
    fitSoon();

    const inputDisposable = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    socket.addEventListener("open", () => {
      setStatus("connected");
      fit();
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as ServerMessage;

      if (message.type === "ready") {
        terminal.writeln(`Connected to ${message.shell} in ${message.cwd}`);
        return;
      }

      if (message.type === "output") {
        terminal.write(message.data);
        return;
      }

      if (message.type === "error") {
        terminal.writeln(`\r\nTerminal error: ${message.error}`);
        return;
      }

      terminal.writeln(`\r\nProcess exited with code ${message.exitCode}`);
    });

    socket.addEventListener("close", () => {
      setStatus("closed");
    });

    const resizeObserver = new ResizeObserver(fitSoon);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      socketRef.current = null;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    window.setTimeout(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const socket = socketRef.current;

      if (!terminal || !fitAddon || socket?.readyState !== WebSocket.OPEN) return;

      fitAddon.fit();
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    }, 0);
  }, [height]);

  return (
    <section className="terminal-panel" style={{ height }}>
      <div className="terminal-resizer" role="separator" aria-orientation="horizontal" title="Resize terminal" onPointerDown={onStartResize} />
      <div className="terminal-header">
        <h2>Terminal</h2>
        <span>{workspaceRoot || "Open a workspace to start a terminal"}</span>
        <strong data-status={status}>{status}</strong>
        <button type="button" className="terminal-close icon-button" title="关闭终端 (Ctrl+`)" aria-label="关闭终端" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="terminal-body" ref={containerRef} />
    </section>
  );
}
