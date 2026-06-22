import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentStep, CommandResult, FileChatHistoryItem, FileChatMessage, TaskPlanItemStatus, TaskSession } from "../api";
import AgentStepsPanel from "./chat/AgentStepsPanel";
import { formatMessageForDisplay, parseCommandSuggestion, type CommandRunState, type CommandSuggestion } from "./chat/chatUtils";
import Icon from "./Icon";
import MarkdownPreview from "./MarkdownPreview";
import TaskPlanPanel from "./TaskPlanPanel";

type Props = {
  chatId: string;
  value: string;
  messages: FileChatMessage[];
  agentSteps: AgentStep[];
  histories: FileChatHistoryItem[];
  taskSessions: TaskSession[];
  activeTaskSession: TaskSession | null;
  selectedTaskSession: TaskSession | null;
  availableFiles: string[];
  contextPaths: string[];
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onClearChat: () => void;
  onOpenHistory: (path: string) => void;
  onRefreshHistories: () => void;
  onRefreshTaskSessions: () => void;
  onOpenTaskSession: (taskSessionId: string) => void;
  onAddPlanItem: (taskSessionId: string, title: string) => Promise<void>;
  onUpdatePlanItem: (taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) => Promise<void>;
  onDeletePlanItem: (taskSessionId: string, planItemId: string) => Promise<void>;
  onRewritePlan: (taskSessionId: string, instruction: string) => Promise<void>;
  onApprovePlan: (taskSessionId: string) => Promise<void>;
  onRollbackCheckpoint: (checkpointId: string) => void;
  onNewChat: () => void;
  onDeleteHistory: (path: string) => void;
  onAddContextPath: (path: string) => void;
  onRemoveContextPath: (path: string) => void;
  onStopChat: () => void;
  onDeleteMessage: (messageId: string) => void;
  onBranchMessage: (messageId: string) => void;
  onRerunMessage: (message: FileChatMessage) => void;
  onRunCommandSuggestion: (suggestion: CommandSuggestion, message: FileChatMessage, options?: { autoSafeOnly?: boolean }) => Promise<CommandResult | null>;
  onGenerate: () => void;
};

export default function ChatPanel({
  chatId,
  value,
  messages,
  agentSteps,
  histories,
  taskSessions,
  activeTaskSession,
  selectedTaskSession,
  availableFiles,
  contextPaths,
  loading,
  streaming,
  disabled,
  onChange,
  onClearChat,
  onOpenHistory,
  onRefreshHistories,
  onRefreshTaskSessions,
  onOpenTaskSession,
  onAddPlanItem,
  onUpdatePlanItem,
  onDeletePlanItem,
  onRewritePlan,
  onApprovePlan,
  onRollbackCheckpoint,
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
  const [showTaskPlan, setShowTaskPlan] = useState(false);
  const [showContextPicker, setShowContextPicker] = useState(false);
  const [contextSearch, setContextSearch] = useState("");
  const [commandRuns, setCommandRuns] = useState<Record<string, CommandRunState>>({});
  const [dismissedCommandSuggestions, setDismissedCommandSuggestions] = useState<Record<string, boolean>>({});
  const autoRunCommandIds = useRef<Set<string>>(new Set());
  const wasStreamingRef = useRef(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const placeholder = "向智能体提问，或直接描述希望修改的内容...";
  const visibleAgentSteps = useMemo<AgentStep[]>(() => {
    return [...agentSteps].sort((left, right) => left.createdAt - right.createdAt);
  }, [agentSteps]);
  const latestAssistantMessageId = useMemo(() => [...messages].reverse().find((message) => message.role === "assistant")?.id || "", [messages]);
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
  const activePlanItems = activeTaskSession?.planItems || [];
  const activePlanCompletedCount = activePlanItems.filter((item) => item.status === "completed").length;
  const activePlanBlockedCount = activePlanItems.filter((item) => item.status === "blocked").length;
  const activePlanPendingApproval = activeTaskSession?.planApproval?.status === "pending";

  useEffect(() => {
    if (!historyRef.current) return;
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [messages, agentSteps]);

  useLayoutEffect(() => {
    const input = inputRef.current;

    if (!input) return;

    input.style.height = "100px";
    input.style.height = Math.min(input.scrollHeight, 180) + "px";
  }, [value]);

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

  function dismissSuggestedCommand(message: FileChatMessage) {
    setDismissedCommandSuggestions((current) => ({
      ...current,
      [message.id]: true
    }));
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
            status: "done",
            command: suggestion.command
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

  async function autoRunSafeCommand(suggestion: CommandSuggestion, message: FileChatMessage) {
    setCommandRuns((current) => ({
      ...current,
      [message.id]: {
        status: "running",
        command: suggestion.command
      }
    }));

    try {
      const result = await onRunCommandSuggestion(suggestion, message, { autoSafeOnly: true });

      if (!result) {
        setCommandRuns((current) => {
          const { [message.id]: _removed, ...rest } = current;
          return rest;
        });
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

  useEffect(() => {
    const justFinishedStreaming = wasStreamingRef.current && !streaming;
    wasStreamingRef.current = streaming;

    if (!justFinishedStreaming || loading || disabled) return;

    const latestAssistantMessage = [...messages].reverse().find((message) => message.role === "assistant");

    if (
      !latestAssistantMessage ||
      commandRuns[latestAssistantMessage.id] ||
      dismissedCommandSuggestions[latestAssistantMessage.id] ||
      autoRunCommandIds.current.has(latestAssistantMessage.id)
    ) {
      return;
    }

    const { suggestion } = parseCommandSuggestion(latestAssistantMessage.content);

    if (!suggestion) return;

    autoRunCommandIds.current.add(latestAssistantMessage.id);
    void autoRunSafeCommand(suggestion, latestAssistantMessage);
  }, [commandRuns, disabled, dismissedCommandSuggestions, loading, messages, streaming]);

  function renderCommandTerminal(runState: CommandRunState) {
    const resultStatus = runState.result ? `Status: ${runState.result.status || "unknown"} / exit ${runState.result.exitCode ?? "null"}` : "";
    const detectedUrl = runState.result?.detectedUrl ? `URL: ${runState.result.detectedUrl}` : "";

    return (
      <div className="chat-command-terminal" aria-live="polite">
        <div className="chat-command-terminal-header">
          <span>{runState.status === "running" ? "Running" : runState.status === "done" ? "Done" : "Failed"}</span>
          <strong>Command</strong>
        </div>
        <pre>
          <code>{["$ " + runState.command, runState.status === "running" ? "Running in Terminal..." : "Output is shown in Terminal.", resultStatus, detectedUrl, runState.error || ""].filter(Boolean).join("\n\n")}</code>
        </pre>
      </div>
    );
  }

  function formatTaskTime(value: number) {
    return new Date(value).toLocaleString();
  }

  function getTaskStatusText(status: TaskSession["status"]) {
    return status === "running" ? "运行中" : status === "success" ? "成功" : status === "failed" ? "失败" : "已取消";
  }

  function renderTaskPathList(items: string[], emptyText: string) {
    return items.length ? (
      <ul>
        {items.map((item) => (
          <li key={item} title={item}>
            {item}
          </li>
        ))}
      </ul>
    ) : (
      <p>{emptyText}</p>
    );
  }

  function renderTaskPlanPanel(session: TaskSession | null, compact = false) {
    return (
      <TaskPlanPanel
        session={session}
        compact={compact}
        loading={loading}
        disabled={disabled}
        onAddItem={(title) => (session ? onAddPlanItem(session.id, title) : Promise.resolve())}
        onUpdateItem={(itemId, updates) => (session ? onUpdatePlanItem(session.id, itemId, updates) : Promise.resolve())}
        onDeleteItem={(itemId) => (session ? onDeletePlanItem(session.id, itemId) : Promise.resolve())}
        onRewritePlan={(instruction) => (session ? onRewritePlan(session.id, instruction) : Promise.resolve())}
        onApprovePlan={() => (session ? onApprovePlan(session.id) : Promise.resolve())}
      />
    );
  }

  function renderTaskPlanTrigger() {
    if (!activeTaskSession) return null;

    const summary = activePlanItems.length ? `${activePlanCompletedCount}/${activePlanItems.length} 完成${activePlanBlockedCount ? ` · ${activePlanBlockedCount} 受阻` : ""}` : "暂无计划";

    return (
      <div className="task-plan-floating">
        <button type="button" className={activePlanPendingApproval ? "task-plan-trigger pending" : "task-plan-trigger"} disabled={disabled} aria-expanded={showTaskPlan} onClick={() => setShowTaskPlan((current) => !current)}>
          <span>{activePlanPendingApproval ? "计划待批准" : "任务计划"}</span>
          <small>{summary}</small>
        </button>
        {showTaskPlan && (
          <div className="task-plan-popover">
            <div className="task-plan-popover-header">
              <strong>任务计划</strong>
              <button type="button" className="icon-button" title="关闭任务计划" aria-label="关闭任务计划" onClick={() => setShowTaskPlan(false)}>
                <Icon name="close" />
              </button>
            </div>
            {renderTaskPlanPanel(activeTaskSession, true)}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="chat-panel">
      <div className="chat-heading">
        <div>
          <h2>智能体</h2>
          <span>{chatId.startsWith("chat:") ? "新对话" : "历史对话"}</span>
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
              onRefreshTaskSessions();
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
      {renderTaskPlanTrigger()}
      {showHistories && (
        <div className="task-history-panel">
          <section className="task-history-section">
            <h3>任务历史</h3>
            <div className="task-history-list">
              {taskSessions.length ? (
                taskSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={selectedTaskSession?.id === session.id ? "active" : ""}
                    disabled={loading}
                    onClick={() => onOpenTaskSession(session.id)}
                  >
                    <strong>{session.userGoal || "智能体任务"}</strong>
                    <span>{getTaskStatusText(session.status)} · {formatTaskTime(session.createdAt)}</span>
                    <small>
                      {session.filesRead.length} 读 / {session.filesChanged.length} 改 / {session.commandsRun.length} 命令
                    </small>
                  </button>
                ))
              ) : (
                <p>No task history.</p>
              )}
            </div>
          </section>
          <section className="task-history-section">
              <h3>旧对话</h3>
            <div className="chat-history-list compact">
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
                <p>No legacy chat history.</p>
              )}
            </div>
          </section>
          {selectedTaskSession && (
            <div className="task-history-detail">
              <div className="task-history-detail-heading">
                <strong>{selectedTaskSession.userGoal || "智能体任务"}</strong>
                <span>{getTaskStatusText(selectedTaskSession.status)} · {formatTaskTime(selectedTaskSession.updatedAt)}</span>
                {selectedTaskSession.chatId && (
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      setShowHistories(false);
                      onOpenHistory(selectedTaskSession.chatId!);
                    }}
                  >
                    打开关联对话
                  </button>
                )}
              </div>
              <section>
                {renderTaskPlanPanel(selectedTaskSession, true)}
              </section>
              <section>
                <h3>读过的文件</h3>
                {renderTaskPathList(selectedTaskSession.filesRead, "没有记录读取文件。")}
              </section>
              <section>
                <h3>改过的文件</h3>
                {renderTaskPathList(selectedTaskSession.filesChanged, "没有记录改动文件。")}
              </section>
              <section>
                <h3>执行过的命令</h3>
                {renderTaskPathList(selectedTaskSession.commandsRun, "没有记录命令。")}
              </section>
              <section>
                <h3>Checkpoints</h3>
                {selectedTaskSession.checkpointIds.length ? (
                  <div className="task-checkpoints">
                    {selectedTaskSession.checkpointIds.map((checkpointId) => (
                      <button key={checkpointId} type="button" disabled={loading} onClick={() => onRollbackCheckpoint(checkpointId)}>
                        回滚 {checkpointId}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p>没有 checkpoint。</p>
                )}
              </section>
              <section>
                <h3>完整过程</h3>
                <AgentStepsPanel steps={selectedTaskSession.steps} />
              </section>
            </div>
          )}
        </div>
      )}
      <div ref={historyRef} className="chat-history">
        {messages.length ? (
          messages.map((message) => {
            const parsedSuggestion = message.role === "assistant" && !streaming ? parseCommandSuggestion(message.content) : { suggestion: null, visibleContent: message.content };
            const commandRun = commandRuns[message.id];
            const showCommandSuggestion = Boolean(parsedSuggestion.suggestion && !commandRun && !dismissedCommandSuggestions[message.id]);
            const isLatestAssistantMessage = message.role === "assistant" && message.id === latestAssistantMessageId;
            const messageAgentSteps = isLatestAssistantMessage ? visibleAgentSteps.filter((step) => step.type !== "command") : [];
            const showAssistantThinking = isLatestAssistantMessage && loading && !parsedSuggestion.visibleContent.trim();

            return (
              <article key={message.id} className={"chat-message " + message.role}>
                <strong className="chat-message-role">{message.role === "user" ? "你" : "智能体"}</strong>
                <AgentStepsPanel inline steps={messageAgentSteps} />
                {editingMessageId === message.id ? (
                  <div className="chat-message-edit">
                    <textarea value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} />
                    <div className="chat-message-actions">
                      <button type="button" className="icon-button" disabled={loading || !editingDraft.trim()} title="保存并重新运行" aria-label="保存并重新运行" onClick={() => rerunEdited(message)}>
                        <Icon name="send" />
                      </button>
                      <button type="button" className="icon-button" disabled={loading} title="取消" aria-label="取消" onClick={() => setEditingMessageId("")}>
                        <Icon name="close" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {showAssistantThinking ? (
                      <p>{messageAgentSteps.length ? "正在处理..." : "正在分析你的请求..."}</p>
                    ) : message.role === "assistant" && !streaming ? (
                      <MarkdownPreview content={parsedSuggestion.visibleContent} />
                    ) : (
                      <p>{formatMessageForDisplay(parsedSuggestion.visibleContent)}</p>
                    )}
                    {showCommandSuggestion && parsedSuggestion.suggestion && (
                      <div className="command-suggestion">
                        <strong>建议命令</strong>
                        <code>{parsedSuggestion.suggestion.command}</code>
                        {parsedSuggestion.suggestion.reason && <p>{parsedSuggestion.suggestion.reason}</p>}
                        <div>
                          {parsedSuggestion.suggestion.risk && <span>{parsedSuggestion.suggestion.risk} risk</span>}
                          <div className="command-suggestion-actions">
                            <button type="button" className="secondary" disabled={loading || streaming} onClick={() => dismissSuggestedCommand(message)}>
                              取消
                            </button>
                            <button type="button" disabled={loading || streaming} onClick={() => void runSuggestedCommand(parsedSuggestion.suggestion!, message)}>
                              执行
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                    {commandRun && renderCommandTerminal(commandRun)}
                  </>
                )}
                <div className="chat-message-actions">
                  <button type="button" className="icon-button" disabled={loading} title="复制" aria-label="复制" onClick={() => navigator.clipboard.writeText(message.content)}>
                    <Icon name="copy" />
                  </button>
                  {message.role === "user" && (
                    <button type="button" className="icon-button" disabled={loading} title="编辑并重新运行" aria-label="编辑并重新运行" onClick={() => startEdit(message)}>
                      <Icon name="edit" />
                    </button>
                  )}
                  {message.role === "assistant" && (
                    <button type="button" className="icon-button" disabled={loading} title="分支" aria-label="分支" onClick={() => onBranchMessage(message.id)}>
                      <Icon name="branch" />
                    </button>
                  )}
                  <button type="button" className="icon-button" disabled={loading} title="删除" aria-label="删除" onClick={() => onDeleteMessage(message.id)}>
                    <Icon name="delete" />
                  </button>
                </div>
              </article>
            );
          })
        ) : (
          <p className="chat-empty">智能体会在这里显示对话和执行过程。</p>
        )}
      </div>
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
        {streaming ? (
          <button type="button" className="icon-button" title="Stop" aria-label="Stop" onClick={onStopChat}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="button" className="icon-button" disabled={disabled || loading || !value.trim()} title="发送" aria-label="发送" onClick={onGenerate}>
            <Icon name="send" />
          </button>
        )}
      </div>
    </aside>
  );
}
