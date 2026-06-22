import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type PointerEvent, useEffect, useRef, useState } from "react";
import type { CommandResult } from "../api";
import Icon from "./Icon";

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
  command: string;
  chatId?: string;
};

export type TerminalCommandCompletion = {
  id: string;
  result: CommandResult | null;
  error?: string;
};

type ServerMessage =
  | { type: "ready"; cwd: string; shell: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number; signal?: number }
  | { type: "error"; error: string };

type ActiveCommand = {
  id: string;
  command: string;
  marker: string;
  output: string;
  startedAt: string;
  chatId?: string;
  timeoutId: number;
  settleTimeoutId: number | null;
  longRunning: boolean;
  reportedSnapshot: boolean;
};

const maxCapturedOutputLength = 80_000;
const maxResultOutputLength = 12_000;
const maxResultPreviewLength = 4_000;
const commandTimeoutMs = 120_000;
const longRunningSettleMs = 3_000;

function getTerminalUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/terminal`;
}

function appendCapturedOutput(current: string, chunk: string) {
  const next = current + chunk;

  if (next.length <= maxCapturedOutputLength) {
    return next;
  }

  return next.slice(next.length - maxCapturedOutputLength);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAnsi(value: string) {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function commandLooksLongRunning(command: string) {
  return /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b|(?:^|\s)(?:vite|next\s+dev|webpack-dev-server|vue-cli-service\s+serve)(?:\s|$)/i.test(command);
}

function tail(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value;
}

function detectUrl(output: string) {
  return output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[[^\]]+\]|[^\s]+)/i)?.[0]?.replace(/[),.;]+$/, "");
}

function createCommandResult(command: string, cwd: string, exitCode: number | null, output: string, startedAt: string, chatId?: string, finishedAt = new Date().toISOString()): CommandResult {
  const cleanedOutput = stripAnsi(output).trim();
  const detectedUrl = detectUrl(cleanedOutput);
  const longRunning = commandLooksLongRunning(command);
  const status = detectedUrl && longRunning ? "running" : exitCode === 0 ? "success" : exitCode === null ? "timeout" : "failed";
  const preview = tail(cleanedOutput, maxResultPreviewLength);
  const summary = [
    status === "running" && detectedUrl ? `Development server is running at ${detectedUrl}.` : "",
    status === "timeout" ? `Command timed out after ${commandTimeoutMs / 1000} seconds.` : "",
    status === "success" ? "Command completed successfully." : "",
    status === "failed" ? `Command failed with exit code ${exitCode}.` : "",
    preview ? `Output preview:\n${preview}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    command,
    chatId,
    cwd,
    exitCode,
    stdout: tail(cleanedOutput, maxResultOutputLength),
    stderr: "",
    summary,
    status,
    detectedUrl,
    outputTruncated: cleanedOutput.length > maxResultOutputLength,
    startedAt,
    finishedAt
  };
}

function shellLooksLikePowerShell(shell: string) {
  return /powershell|pwsh/i.test(shell);
}

function shellLooksLikeCmd(shell: string) {
  return /(?:^|[\\/])cmd(?:\.exe)?$/i.test(shell) || /^cmd(?:\.exe)?$/i.test(shell);
}

function wrapCommandForCompletion(command: string, requestId: string, shell: string) {
  const markerPrefix = "__AI_CMD_DONE_";
  const marker = `${markerPrefix}${requestId}:`;

  if (shellLooksLikePowerShell(shell)) {
    return {
      marker,
      input: `${command}; $codexStatus = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }; $codexM = '${markerPrefix}'; Write-Output ($codexM + '${requestId}' + ':' + $codexStatus)\r`
    };
  }

  if (shellLooksLikeCmd(shell)) {
    return {
      marker,
      input: `set __codex_m=${markerPrefix} & ${command} & echo %__codex_m%${requestId}:%ERRORLEVEL%\r`
    };
  }

  return {
    marker,
    input: `{ ${command}; }; __codex_status=$?; __codex_m=${markerPrefix}; printf '\\n%s%s:%s\\n' "$__codex_m" "${requestId}" "$__codex_status"\r`
  };
}

export default function TerminalPanel({ workspaceRoot, height, commandRequest, onClose, onStartResize, onCommandComplete }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const lastCommandRequestIdRef = useRef("");
  const activeCommandRef = useRef<ActiveCommand | null>(null);
  const terminalCwdRef = useRef("");
  const terminalShellRef = useRef("");
  const [status, setStatus] = useState<"connecting" | "connected" | "closed">("closed");
  const [terminalReady, setTerminalReady] = useState(false);
  const [runningCommand, setRunningCommand] = useState(false);

  function completeActiveCommand(exitCode: number | null, output: string) {
    const activeCommand = activeCommandRef.current;

    if (!activeCommand) return;

    window.clearTimeout(activeCommand.timeoutId);
    if (activeCommand.settleTimeoutId) {
      window.clearTimeout(activeCommand.settleTimeoutId);
    }
    activeCommandRef.current = null;
    setRunningCommand(false);
    onCommandComplete?.({
      id: activeCommand.id,
      result: createCommandResult(activeCommand.command, terminalCwdRef.current || workspaceRoot, exitCode, output, activeCommand.startedAt, activeCommand.chatId)
    });
  }

  function failActiveCommand(message: string) {
    const activeCommand = activeCommandRef.current;

    if (!activeCommand) return;

    window.clearTimeout(activeCommand.timeoutId);
    if (activeCommand.settleTimeoutId) {
      window.clearTimeout(activeCommand.settleTimeoutId);
    }
    activeCommandRef.current = null;
    setRunningCommand(false);
    onCommandComplete?.({ id: activeCommand.id, result: null, error: message });
  }

  function reportLongRunningSnapshot() {
    const activeCommand = activeCommandRef.current;

    if (!activeCommand || !activeCommand.longRunning || activeCommand.reportedSnapshot || !activeCommand.output.trim()) return;

    activeCommand.reportedSnapshot = true;
    onCommandComplete?.({
      id: activeCommand.id,
      result: createCommandResult(activeCommand.command, terminalCwdRef.current || workspaceRoot, null, activeCommand.output, activeCommand.startedAt, activeCommand.chatId)
    });
  }

  function scheduleLongRunningSnapshot() {
    const activeCommand = activeCommandRef.current;

    if (!activeCommand?.longRunning || activeCommand.reportedSnapshot) return;

    if (activeCommand.settleTimeoutId) {
      window.clearTimeout(activeCommand.settleTimeoutId);
    }

    activeCommand.settleTimeoutId = window.setTimeout(reportLongRunningSnapshot, longRunningSettleMs);
  }

  function captureTerminalOutput(data: string) {
    const activeCommand = activeCommandRef.current;

    if (!activeCommand) return;

    const nextOutput = appendCapturedOutput(activeCommand.output, data);
    const markerMatch = nextOutput.match(new RegExp(`\\r?\\n?${escapeRegExp(activeCommand.marker)}(-?\\d+)`));

    if (!markerMatch || markerMatch.index === undefined) {
      activeCommand.output = nextOutput;
      scheduleLongRunningSnapshot();
      return;
    }

    const exitCode = Number.parseInt(markerMatch[1], 10);
    completeActiveCommand(Number.isFinite(exitCode) ? exitCode : null, nextOutput.slice(0, markerMatch.index));
  }

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
    terminalCwdRef.current = "";
    terminalShellRef.current = "";
    setStatus("connecting");
    setTerminalReady(false);

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
        terminalCwdRef.current = message.cwd;
        terminalShellRef.current = message.shell;
        setTerminalReady(true);
        terminal.writeln(`Connected to ${message.shell} in ${message.cwd}`);
        return;
      }

      if (message.type === "output") {
        captureTerminalOutput(message.data);
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
      setTerminalReady(false);
    });

    const resizeObserver = new ResizeObserver(fitSoon);
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      if (activeCommandRef.current) {
        window.clearTimeout(activeCommandRef.current.timeoutId);
        if (activeCommandRef.current.settleTimeoutId) {
          window.clearTimeout(activeCommandRef.current.settleTimeoutId);
        }
        activeCommandRef.current = null;
      }
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

  async function handleRunCommand(command: string, request?: TerminalCommandRequest) {
    const trimmedCommand = command.trim();

    if (!trimmedCommand || runningCommand) return false;

    if (activeCommandRef.current?.reportedSnapshot) {
      activeCommandRef.current = null;
      setRunningCommand(false);
    }

    if (activeCommandRef.current) return false;

    const socket = socketRef.current;
    const terminal = terminalRef.current;

    if (!terminal || socket?.readyState !== WebSocket.OPEN || !terminalReady || !terminalShellRef.current) {
      if (request) {
        onCommandComplete?.({ id: request.id, result: null, error: "Terminal is not ready yet." });
      }
      return false;
    }

    setRunningCommand(true);

    try {
      if (request) {
        const wrappedCommand = wrapCommandForCompletion(trimmedCommand, request.id, terminalShellRef.current);
        const timeoutId = window.setTimeout(() => {
          if (activeCommandRef.current?.reportedSnapshot) {
            activeCommandRef.current = null;
            setRunningCommand(false);
            return;
          }

          terminal.writeln(`\r\n[command error] Command timed out after ${commandTimeoutMs / 1000} seconds while waiting for completion marker.`);
          failActiveCommand("Command timed out while waiting for terminal completion.");
        }, commandTimeoutMs);

        activeCommandRef.current = {
          id: request.id,
          command: trimmedCommand,
          marker: wrappedCommand.marker,
          output: "",
          startedAt: new Date().toISOString(),
          chatId: request.chatId,
          timeoutId,
          settleTimeoutId: null,
          longRunning: commandLooksLongRunning(trimmedCommand),
          reportedSnapshot: false
        };
        socket.send(JSON.stringify({ type: "input", data: wrappedCommand.input }));
      } else {
        socket.send(JSON.stringify({ type: "input", data: `${trimmedCommand}\r` }));
        setRunningCommand(false);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run command";
      terminal.writeln(`\r\n[command error] ${message}`);
      if (request) {
        onCommandComplete?.({ id: request.id, result: null, error: message });
      }
      setRunningCommand(false);
      activeCommandRef.current = null;
      return false;
    }
  }

  useEffect(() => {
    const socket = socketRef.current;

    if (!commandRequest || !workspaceRoot || runningCommand || !terminalReady || !terminalRef.current || socket?.readyState !== WebSocket.OPEN) return;
    if (lastCommandRequestIdRef.current === commandRequest.id) return;

    void handleRunCommand(commandRequest.command, commandRequest).then((started) => {
      if (started) {
        lastCommandRequestIdRef.current = commandRequest.id;
      }
    });
  }, [commandRequest, runningCommand, status, terminalReady, workspaceRoot]);

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
