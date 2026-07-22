import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import {
  fetchCommandExecutionOutput,
  fetchCommandExecutions,
  moveCommandExecutionToBackground,
  stopCommandExecution,
  type CommandExecution,
  type CommandResult
} from "../api";
import Icon from "./Icon";
import CommandExecutionList from "./commandExecution/CommandExecutionList";

type Props = {
  workspaceRoot: string;
  height: number;
  commandRequest?: TerminalCommandRequest | null;
  onClose: () => void;
  onStartResize: (event: PointerEvent<HTMLDivElement>) => void;
  onCommandComplete?: (completion: TerminalCommandCompletion) => void;
};

export type TerminalCommandRequest = {
  id: string;
  execution: CommandExecution;
};

export type TerminalCommandCompletion = {
  id: string;
  execution?: CommandExecution;
  result: CommandResult | null;
  phase?: "ready" | "finished";
  error?: string;
};

type ServerMessage =
  | { type: "ready"; cwd: string; shell: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; error: string }
  | { type: "command.started" | "command.ready" | "command.finished"; execution: CommandExecution }
  | { type: "command.output"; id: string; cursor: number; data: string }
  | { type: "command.error"; id: string; message: string };

const terminalStates = new Set<CommandExecution["state"]>(["succeeded", "failed", "cancelled"]);
const maxCapturedOutputLength = 80_000;

function getTerminalUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal`;
}

function executionResult(execution: CommandExecution, output: string): CommandResult {
  const status: CommandResult["status"] = execution.state === "succeeded"
    ? "success"
    : execution.state === "running"
      ? "running"
      : execution.state === "cancelled"
        ? "cancelled"
      : "failed";
  const summary = execution.readiness === "ready" && execution.readyUrl
    ? `服务已就绪：${execution.readyUrl}`
    : status === "success"
      ? "命令执行成功。"
      : status === "running"
        ? "命令仍在后台运行。"
        : execution.state === "cancelled"
          ? "命令已停止。"
          : `命令执行失败${execution.exitCode === null ? "" : `，退出码 ${execution.exitCode}`}。`;

  return {
    command: execution.command,
    chatId: execution.chatId,
    cwd: execution.cwd,
    exitCode: execution.exitCode,
    stdout: output,
    stderr: "",
    summary,
    status,
    detectedUrl: execution.readyUrl,
    detectedUrls: execution.detectedUrls,
    waitTimedOut: execution.waitTimedOut,
    outputTruncated: execution.outputTruncated,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt || execution.readyAt || new Date().toISOString()
  };
}

/** 终端只展示并控制服务端 execution；手工输入仍通过独立 PTY 协议发送。 */
export default function TerminalPanel({ workspaceRoot, height, commandRequest, onClose, onStartResize, onCommandComplete }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const cursorByExecutionRef = useRef(new Map<string, number>());
  const outputByExecutionRef = useRef(new Map<string, string>());
  const subscribedIdsRef = useRef(new Set<string>());
  const reportedReadyRef = useRef(new Set<string>());
  const reportedFinishedRef = useRef(new Set<string>());
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">("closed");
  const [activeExecution, setActiveExecution] = useState<CommandExecution | null>(null);

  function writeExecutionOutput(id: string, cursor: number, data: string) {
    const knownCursor = cursorByExecutionRef.current.get(id) || 0;
    const endCursor = cursor + data.length;
    if (endCursor <= knownCursor) return;

    const unseen = knownCursor > cursor ? data.slice(knownCursor - cursor) : data;
    cursorByExecutionRef.current.set(id, endCursor);
    const nextOutput = (outputByExecutionRef.current.get(id) || "") + unseen;
    outputByExecutionRef.current.set(id, nextOutput.slice(-maxCapturedOutputLength));
    terminalRef.current?.write(unseen);
  }

  function reportExecution(execution: CommandExecution, phase: "ready" | "finished") {
    const reported = phase === "ready" ? reportedReadyRef.current : reportedFinishedRef.current;
    if (reported.has(execution.id)) return;
    reported.add(execution.id);
    onCommandComplete?.({
      id: execution.id,
      execution,
      phase,
      result: executionResult(execution, outputByExecutionRef.current.get(execution.id) || "")
    });
  }

  async function subscribeExecution(execution: CommandExecution) {
    setActiveExecution(execution);
    subscribedIdsRef.current.add(execution.id);
    // 切换任务时从磁盘日志重新绘制完整视图，后续增量仍由 cursor 去重。
    terminalRef.current?.clear();
    cursorByExecutionRef.current.set(execution.id, 0);
    outputByExecutionRef.current.set(execution.id, "");
    const cursor = 0;

    // WebSocket 可能在断线期间丢失事件，订阅前先用 HTTP cursor 补拉。
    try {
      const { output } = await fetchCommandExecutionOutput(execution.id, cursor);
      writeExecutionOutput(execution.id, output.cursor, output.data);
    } catch (error) {
      terminalRef.current?.writeln(`\r\n[execution error] ${error instanceof Error ? error.message : "无法补拉命令输出"}`);
    }

    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "command.subscribe", id: execution.id, cursor: cursorByExecutionRef.current.get(execution.id) || 0 }));
    }
  }

  useEffect(() => {
    if (!containerRef.current || !workspaceRoot) return;
    disposedRef.current = false;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      theme: { background: "#111827", foreground: "#e5edf7", cursor: "#f8fafc", selectionBackground: "#334155" }
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      fitAddon.fit();
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    };

    const connect = () => {
      if (disposedRef.current) return;
      setStatus("connecting");
      const socket = new WebSocket(getTerminalUrl());
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        setStatus("connected");
        fit();
        for (const id of subscribedIdsRef.current) {
          const cursor = cursorByExecutionRef.current.get(id) || 0;
          // 重连后先通过 HTTP 补齐断线窗口，再从新的 cursor 恢复实时订阅。
          void fetchCommandExecutionOutput(id, cursor).then(({ output }) => {
            writeExecutionOutput(id, output.cursor, output.data);
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "command.subscribe", id, cursor: cursorByExecutionRef.current.get(id) || 0 }));
            }
          }).catch((error) => {
            terminal.writeln(`\r\n[execution error] ${error instanceof Error ? error.message : "无法恢复命令输出"}`);
          });
        }
      });
      socket.addEventListener("message", (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(event.data) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "ready") {
          terminal.writeln(`Connected to ${message.shell} in ${message.cwd}`);
        } else if (message.type === "output") {
          terminal.write(message.data);
        } else if (message.type === "error") {
          terminal.writeln(`\r\nTerminal error: ${message.error}`);
        } else if (message.type === "exit") {
          terminal.writeln(`\r\nProcess exited with code ${message.exitCode}`);
        } else if (message.type === "command.output") {
          writeExecutionOutput(message.id, message.cursor, message.data);
        } else if (message.type === "command.error") {
          terminal.writeln(`\r\n[execution error] ${message.message}`);
          onCommandComplete?.({ id: message.id, result: null, error: message.message });
        } else {
          setActiveExecution(message.execution);
          if (message.type === "command.ready") reportExecution(message.execution, "ready");
          if (message.type === "command.finished") reportExecution(message.execution, "finished");
        }
      });
      socket.addEventListener("close", () => {
        if (socketRef.current === socket) socketRef.current = null;
        setStatus("closed");
        if (!disposedRef.current) reconnectTimerRef.current = window.setTimeout(connect, 1000);
      });
    };

    const inputDisposable = terminal.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data }));
    });
    const resizeObserver = new ResizeObserver(() => window.setTimeout(fit, 0));
    resizeObserver.observe(containerRef.current);
    connect();

    // 页面刷新后恢复最近一条仍在运行的 execution 与已有日志。
    void fetchCommandExecutions({ state: "running" }).then(({ executions }) => {
      const latest = executions.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      if (latest) void subscribeExecution(latest);
    }).catch(() => undefined);

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      socketRef.current?.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      socketRef.current = null;
    };
  }, [workspaceRoot]);

  useEffect(() => {
    window.setTimeout(() => fitAddonRef.current?.fit(), 0);
  }, [height]);

  useEffect(() => {
    if (!commandRequest || subscribedIdsRef.current.has(commandRequest.id)) return;
    terminalRef.current?.writeln(`\r\n> ${commandRequest.execution.command}\r\n`);
    void subscribeExecution(commandRequest.execution);
  }, [commandRequest]);

  async function handleStop() {
    if (!activeExecution) return;
    const { execution } = await stopCommandExecution(activeExecution.id);
    setActiveExecution(execution);
  }

  async function handleBackground() {
    if (!activeExecution) return;
    const { execution } = await moveCommandExecutionToBackground(activeExecution.id);
    setActiveExecution(execution);
  }

  const canControl = activeExecution && !terminalStates.has(activeExecution.state);
  return (
    <section className="terminal-panel" style={{ height }}>
      <div className="terminal-resizer" role="separator" aria-orientation="horizontal" title="Resize terminal" onPointerDown={onStartResize} />
      <div className="terminal-header">
        <h2>Terminal</h2>
        <span>{activeExecution ? `${activeExecution.command} · ${activeExecution.state}/${activeExecution.readiness}` : workspaceRoot || "Open a workspace to start a terminal"}</span>
        <div className="terminal-execution-actions">
          {canControl && activeExecution.mode !== "background" && <button type="button" onClick={() => void handleBackground()}>转入后台</button>}
          {canControl && <button type="button" onClick={() => void handleStop()}>停止</button>}
          {activeExecution && <button type="button" onClick={() => void subscribeExecution(activeExecution)}>重新打开</button>}
        </div>
        <strong data-status={status}>{status}</strong>
        <button type="button" className="terminal-close icon-button" title="关闭终端 (Ctrl+`)" aria-label="关闭终端" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="terminal-content">
        <CommandExecutionList activeExecutionId={activeExecution?.id} onOpen={(execution) => void subscribeExecution(execution)} />
        <div className="terminal-body" ref={containerRef} />
      </div>
    </section>
  );
}
