import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileChatHistoryItem, FileChatMessage } from "../api";
import Icon from "./Icon";
import MarkdownPreview from "./MarkdownPreview";

type Props = {
  value: string;
  mode: "chat" | "edit";
  messages: FileChatMessage[];
  histories: FileChatHistoryItem[];
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onModeChange: (mode: "chat" | "edit") => void;
  onClearChat: () => void;
  onOpenHistory: (path: string) => void;
  onRefreshHistories: () => void;
  onStopChat: () => void;
  onDeleteMessage: (messageId: string) => void;
  onBranchMessage: (messageId: string) => void;
  onRerunMessage: (message: FileChatMessage) => void;
  onGenerate: () => void;
};

export default function ChatPanel({
  value,
  mode,
  messages,
  histories,
  loading,
  streaming,
  disabled,
  onChange,
  onModeChange,
  onClearChat,
  onOpenHistory,
  onRefreshHistories,
  onStopChat,
  onDeleteMessage,
  onBranchMessage,
  onRerunMessage,
  onGenerate
}: Props) {
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingDraft, setEditingDraft] = useState("");
  const [showHistories, setShowHistories] = useState(false);
  const historyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const placeholder = mode === "chat" ? "围绕当前文件继续提问..." : "描述你想对当前文件做的修改...";

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

  return (
    <aside className="chat-panel">
      <div className="chat-heading">
        <h2>AI 聊天</h2>
        <div className="chat-heading-actions">
          <button
            type="button"
            className="icon-button"
            disabled={loading}
            title="历史"
            aria-label="历史"
            onClick={() => {
              onRefreshHistories();
              setShowHistories((current) => !current);
            }}
          >
            <Icon name="history" />
          </button>
          <button type="button" className="icon-button" disabled={disabled || loading || !messages.length} title="清空" aria-label="清空" onClick={onClearChat}>
            <Icon name="clear" />
          </button>
        </div>
      </div>
      {showHistories && (
        <div className="chat-history-list">
          {histories.length ? (
            histories.map((item) => (
              <button
                key={item.path}
                type="button"
                disabled={loading}
                onClick={() => {
                  setShowHistories(false);
                  onOpenHistory(item.path);
                }}
              >
                <strong>{item.path}</strong>
                <span>{item.messageCount} 条消息</span>
                <small>{item.preview || "暂无预览"}</small>
              </button>
            ))
          ) : (
            <p>暂无聊天历史。</p>
          )}
        </div>
      )}
      {mode === "chat" && (
        <div ref={historyRef} className="chat-history">
          {messages.length ? (
            messages.map((message) => (
              <article key={message.id} className={`chat-message ${message.role}`}>
                <strong className="chat-message-role">{message.role === "user" ? "你" : "AI"}</strong>
                {editingMessageId === message.id ? (
                  <div className="chat-message-edit">
                    <textarea value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} />
                    <div className="chat-message-actions">
                      <button type="button" className="icon-button" disabled={loading || !editingDraft.trim()} title="保存并重跑" aria-label="保存并重跑" onClick={() => rerunEdited(message)}>
                        <Icon name="send" />
                      </button>
                      <button type="button" className="icon-button" disabled={loading} title="取消" aria-label="取消" onClick={() => setEditingMessageId("")}>
                        <Icon name="close" />
                      </button>
                    </div>
                  </div>
                ) : (
                  message.role === "assistant" ? <MarkdownPreview content={message.content} /> : <p>{message.content}</p>
                )}
                <div className="chat-message-actions">
                  <button type="button" className="icon-button" disabled={loading} title="复制" aria-label="复制" onClick={() => navigator.clipboard.writeText(message.content)}>
                    <Icon name="copy" />
                  </button>
                  {message.role === "user" && (
                    <button type="button" className="icon-button" disabled={loading} title="编辑重跑" aria-label="编辑重跑" onClick={() => startEdit(message)}>
                      <Icon name="edit" />
                    </button>
                  )}
                  <button type="button" className="icon-button" disabled={loading} title="分支" aria-label="分支" onClick={() => onBranchMessage(message.id)}>
                    <Icon name="branch" />
                  </button>
                  <button type="button" className="icon-button" disabled={loading} title="删除" aria-label="删除" onClick={() => onDeleteMessage(message.id)}>
                    <Icon name="delete" />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <p className="chat-empty">当前文件暂无对话。</p>
          )}
        </div>
      )}
      <div className="chat-composer">
        <select className="chat-mode-select" value={mode} disabled={loading} title="选择 AI 模式" aria-label="选择 AI 模式" onChange={(event) => onModeChange(event.target.value as "chat" | "edit")}>
          <option value="chat">聊天</option>
          <option value="edit">修改</option>
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
          <button type="button" className="icon-button" title="停止" aria-label="停止" onClick={onStopChat}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="button" className="icon-button" disabled={disabled || loading || !value.trim()} title={mode === "chat" ? "发送" : "生成修改"} aria-label={mode === "chat" ? "发送" : "生成修改"} onClick={onGenerate}>
            <Icon name={mode === "chat" ? "send" : "edit"} />
          </button>
        )}
      </div>
    </aside>
  );
}
