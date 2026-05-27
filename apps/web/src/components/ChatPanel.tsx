import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandResult, FileChatHistoryItem, FileChatMessage } from "../api";
import Icon from "./Icon";
import MarkdownPreview from "./MarkdownPreview";

type CommandSuggestion = {
  command: string;
  reason?: string;
  risk?: string;
};

type CommandRunState = {
  status: "running" | "done" | "error";
  command: string;
  result?: CommandResult;
  error?: string;
};

type Props = {
  chatId: string;
  value: string;
  mode: "chat" | "edit";
  messages: FileChatMessage[];
  histories: FileChatHistoryItem[];
  availableFiles: string[];
  contextPaths: string[];
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onModeChange: (mode: "chat" | "edit") => void;
  onClearChat: () => void;
  onOpenHistory: (path: string) => void;
  onRefreshHistories: () => void;
  onNewChat: () => void;
  onDeleteHistory: (path: string) => void;
  onAddContextPath: (path: string) => void;
  onRemoveContextPath: (path: string) => void;
  onStopChat: () => void;
  onDeleteMessage: (messageId: string) => void;
  onBranchMessage: (messageId: string) => void;
  onRerunMessage: (message: FileChatMessage) => void;
  onRunCommandSuggestion: (suggestion: CommandSuggestion, message: FileChatMessage) => Promise<CommandResult | null>;
  onGenerate: () => void;
};

function parseCommandSuggestion(content: string): { suggestion: CommandSuggestion | null; visibleContent: string } {
  const blockMatch = content.match(/```command-suggestion\s*([\s\S]*?)\s*```/i);

  if (!blockMatch?.[1]) {
    return { suggestion: null, visibleContent: content };
  }

  try {
    const parsed = JSON.parse(blockMatch[1]) as Partial<CommandSuggestion>;

    if (!parsed.command?.trim()) {
      return { suggestion: null, visibleContent: content };
    }

    return {
      suggestion: {
        command: parsed.command.trim(),
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
        risk: typeof parsed.risk === "string" ? parsed.risk : ""
      },
      visibleContent: content.replace(blockMatch[0], "").trim()
    };
  } catch {
    return { suggestion: null, visibleContent: content };
  }
}

export default function ChatPanel({
  chatId,
  value,
  mode,
  messages,
  histories,
  availableFiles,
  contextPaths,
  loading,
  streaming,
  disabled,
  onChange,
  onModeChange,
  onClearChat,
  onOpenHistory,
  onRefreshHistories,
  onNewChat,
  onDeleteHistory,
  onAddContextPath,
  onRemoveContextPath,
  onStopChat,
  onDeleteMessage,
  onBranchMessage,
  onRerunMessage,
  onRunCommandSuggestion,
  onGenerate
}: Props) {
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingDraft, setEditingDraft] = useState("");
  const [showHistories, setShowHistories] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextSearch, setContextSearch] = useState("");
  const [commandRuns, setCommandRuns] = useState<Record<string, CommandRunState>>({});
  const historyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const placeholder = mode === "chat" ? "Ask about the current file..." : "Describe the edit you want for this file...";
  const contextSearchResults = useMemo(() => {
    const query = contextSearch.trim().toLowerCase();

    return availableFiles
      .filter((filePath) => !contextPaths.includes(filePath))
      .filter((filePath) => {
        if (!query) return true;
        return query
          .split(/\s+/)
          .filter(Boolean)
          .every((part) => filePath.toLowerCase().includes(part));
      })
      .slice(0, 80);
  }, [availableFiles, contextPaths, contextSearch]);

  useEffect(() => {
    if (!historyRef.current) return;
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    const input = inputRef.current;

    if (!input) return;

    input.style.height = "100px";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  }, [value, mode]);

  function startEdit(message: FileChatMessage) {
    setEditingMessageId(message.id);
    setEditingDraft(message.content);
  }

  function rerunEdited(message: FileChatMessage) {
    const nextContent = editingDraft.trim();

    if (!nextContent) return;

    setEditingMessageId("");
    setEditingDraft("");
    onRerunMessage({ ...message, content: nextContent });
  }

  async function runSuggestedCommand(suggestion: CommandSuggestion, message: FileChatMessage) {
    setCommandRuns((current) => ({
      ...current,
      [message.id]: {
        status: "running",
        command: suggestion.command
      }
    }));

    try {
      const result = await onRunCommandSuggestion(suggestion, message);

      if (!result) {
        setCommandRuns((current) => ({
          ...current,
          [message.id]: {
            status: "error",
            command: suggestion.command,
            error: "Command did not return a result."
          }
        }));
        return;
      }

      setCommandRuns((current) => ({
        ...current,
        [message.id]: {
          status: "done",
          command: suggestion.command,
          result
        }
      }));
    } catch (error) {
      setCommandRuns((current) => ({
        ...current,
        [message.id]: {
          status: "error",
          command: suggestion.command,
          error: error instanceof Error ? error.message : "Command failed."
        }
      }));
    }
  }

  function renderCommandTerminal(runState: CommandRunState) {
    const output = runState.result ? [runState.result.stderr, runState.result.stdout].filter(Boolean).join("\n") : "";

    return (
      <div className="chat-command-terminal" aria-live="polite">
        <div className="chat-command-terminal-header">
          <span>{runState.status === "running" ? "Running" : runState.status === "done" ? "Finished" : "Failed"}</span>
          {runState.result && <strong>exit {runState.result.exitCode ?? "null"}</strong>}
        </div>
        <pre>
          <code>{[`$ ${runState.command}`, runState.status === "running" ? "Running command..." : "", output, runState.error || ""].filter(Boolean).join("\n\n")}</code>
        </pre>
      </div>
    );
  }

  return (
    <aside className="chat-panel">
      <div className="chat-heading">
        <div>
          <h2>AI Chat</h2>
          <span>{chatId.startsWith("chat:") ? "New conversation" : "History conversation"}</span>
        </div>
        <div className="chat-heading-actions">
          <button type="button" className="icon-button" disabled={loading} title="New chat" aria-label="New chat" onClick={onNewChat}>
            <Icon name="chat" />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={loading}
            title="History"
            aria-label="History"
            onClick={() => {
              onRefreshHistories();
              setShowHistories((current) => !current);
            }}
          >
            <Icon name="history" />
          </button>
          <button type="button" className="icon-button" disabled={disabled || loading || !messages.length} title="Clear" aria-label="Clear" onClick={onClearChat}>
            <Icon name="clear" />
          </button>
        </div>
      </div>
      {showHistories && (
        <div className="chat-history-list">
          {histories.length ? (
            histories.map((item) => (
              <div key={item.path} className="chat-history-item">
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setShowHistories(false);
                    onOpenHistory(item.path);
                  }}
                >
                  <strong>{item.path}</strong>
                  <span>{item.messageCount} messages</span>
                  <small>{item.preview || "No preview"}</small>
                </button>
                <button type="button" className="icon-button chat-history-delete" disabled={loading} title="Delete history" aria-label="Delete history" onClick={() => onDeleteHistory(item.path)}>
                  <Icon name="delete" />
                </button>
              </div>
            ))
          ) : (
            <p>No chat history.</p>
          )}
        </div>
      )}
      {mode === "chat" && (
        <div ref={historyRef} className="chat-history">
          {messages.length ? (
            messages.map((message) => {
              const parsedSuggestion = message.role === "assistant" ? parseCommandSuggestion(message.content) : { suggestion: null, visibleContent: message.content };
              const commandRun = commandRuns[message.id];

              return (
                <article key={message.id} className={`chat-message ${message.role}`}>
                  <strong className="chat-message-role">{message.role === "user" ? "You" : "AI"}</strong>
                  {editingMessageId === message.id ? (
                    <div className="chat-message-edit">
                      <textarea value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} />
                      <div className="chat-message-actions">
                        <button type="button" className="icon-button" disabled={loading || !editingDraft.trim()} title="Save and rerun" aria-label="Save and rerun" onClick={() => rerunEdited(message)}>
                          <Icon name="send" />
                        </button>
                        <button type="button" className="icon-button" disabled={loading} title="Cancel" aria-label="Cancel" onClick={() => setEditingMessageId("")}>
                          <Icon name="close" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {message.role === "assistant" ? <MarkdownPreview content={parsedSuggestion.visibleContent} /> : <p>{message.content}</p>}
                      {parsedSuggestion.suggestion && (
                        <div className="command-suggestion">
                          <strong>Suggested command</strong>
                          <code>{parsedSuggestion.suggestion.command}</code>
                          {parsedSuggestion.suggestion.reason && <p>{parsedSuggestion.suggestion.reason}</p>}
                          <div>
                            {parsedSuggestion.suggestion.risk && <span>{parsedSuggestion.suggestion.risk} risk</span>}
                            <button type="button" disabled={loading || streaming || commandRun?.status === "running"} onClick={() => void runSuggestedCommand(parsedSuggestion.suggestion!, message)}>
                              Run command
                            </button>
                          </div>
                        </div>
                      )}
                      {commandRun && renderCommandTerminal(commandRun)}
                    </>
                  )}
                  <div className="chat-message-actions">
                    <button type="button" className="icon-button" disabled={loading} title="Copy" aria-label="Copy" onClick={() => navigator.clipboard.writeText(message.content)}>
                      <Icon name="copy" />
                    </button>
                    {message.role === "user" && (
                      <button type="button" className="icon-button" disabled={loading} title="Edit and rerun" aria-label="Edit and rerun" onClick={() => startEdit(message)}>
                        <Icon name="edit" />
                      </button>
                    )}
                    {message.role === "assistant" && (
                      <button type="button" className="icon-button" disabled={loading} title="Branch" aria-label="Branch" onClick={() => onBranchMessage(message.id)}>
                        <Icon name="branch" />
                      </button>
                    )}
                    <button type="button" className="icon-button" disabled={loading} title="Delete" aria-label="Delete" onClick={() => onDeleteMessage(message.id)}>
                      <Icon name="delete" />
                    </button>
                  </div>
                </article>
              );
            })
          ) : (
            <p className="chat-empty">No conversation for the current file.</p>
          )}
        </div>
      )}
      <div className="chat-composer">
        <div className="chat-context-bar">
          <button
            type="button"
            className="chat-context-add"
            disabled={disabled || loading || !availableFiles.length}
            onClick={() => {
              setShowContextPicker((current) => !current);
              setContextSearch("");
            }}
          >
            + Files
          </button>
          {contextPaths.length > 0 && (
            <div className="chat-context-chips">
              {contextPaths.map((filePath) => (
                <button key={filePath} type="button" disabled={loading} title={filePath} onClick={() => onRemoveContextPath(filePath)}>
                  <span>{filePath}</span>
                  <Icon name="close" />
                </button>
              ))}
            </div>
          )}
        </div>
        {showContextPicker && (
          <div className="chat-context-popover">
            <div className="chat-context-popover-header">
              <strong>Add context files</strong>
              <button type="button" className="icon-button" title="Close" aria-label="Close" onClick={() => setShowContextPicker(false)}>
                <Icon name="close" />
              </button>
            </div>
            <input autoFocus value={contextSearch} placeholder="Search files..." onChange={(event) => setContextSearch(event.target.value)} />
            <div className="chat-context-results">
              {contextSearchResults.length ? (
                contextSearchResults.map((filePath) => (
                  <button
                    key={filePath}
                    type="button"
                    onClick={() => {
                      onAddContextPath(filePath);
                      setContextSearch("");
                    }}
                  >
                    {filePath}
                  </button>
                ))
              ) : (
                <p>No matching files.</p>
              )}
            </div>
          </div>
        )}
        <select className="chat-mode-select" value={mode} disabled={loading} title="Choose AI mode" aria-label="Choose AI mode" onChange={(event) => onModeChange(event.target.value as "chat" | "edit")}>
          <option value="chat">Chat</option>
          <option value="edit">Edit</option>
        </select>
        <textarea
          ref={inputRef}
          value={value}
          disabled={disabled || loading}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault();
            onGenerate();
          }}
        />
        {streaming && mode === "chat" ? (
          <button type="button" className="icon-button" title="Stop" aria-label="Stop" onClick={onStopChat}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="button" className="icon-button" disabled={disabled || loading || !value.trim()} title={mode === "chat" ? "Send" : "Generate edit"} aria-label={mode === "chat" ? "Send" : "Generate edit"} onClick={onGenerate}>
            <Icon name={mode === "chat" ? "send" : "edit"} />
          </button>
        )}
      </div>
    </aside>
  );
}
