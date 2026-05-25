import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FileChatHistoryItem, FileChatMessage } from "../api";

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
  const buttonText = mode === "chat" ? "发送" : "生成";
  const placeholder = mode === "chat" ? "围绕当前文件继续提问..." : "描述你想对当前文件做的修改...";

  useEffect(() => {
    if (!historyRef.current) return;
    historyRef.current.scrollTop = historyRef.current.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    const input = inputRef.current;

    if (!input) return;

    input.style.height = "50px";
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
            disabled={loading}
            onClick={() => {
              onRefreshHistories();
              setShowHistories((current) => !current);
            }}
          >
            历史
          </button>
          <button type="button" disabled={disabled || loading || !messages.length} onClick={onClearChat}>
            清空
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
      <div className="chat-mode">
        <button type="button" className={mode === "chat" ? "active" : ""} disabled={loading} onClick={() => onModeChange("chat")}>
          聊天
        </button>
        <button type="button" className={mode === "edit" ? "active" : ""} disabled={loading} onClick={() => onModeChange("edit")}>
          修改
        </button>
      </div>
      {mode === "chat" && (
        <div ref={historyRef} className="chat-history">
          {messages.length ? (
            messages.map((message) => (
              <article key={message.id} className={`chat-message ${message.role}`}>
                <strong>{message.role === "user" ? "你" : "AI"}</strong>
                {editingMessageId === message.id ? (
                  <div className="chat-message-edit">
                    <textarea value={editingDraft} onChange={(event) => setEditingDraft(event.target.value)} />
                    <div className="chat-message-actions">
                      <button type="button" disabled={loading || !editingDraft.trim()} onClick={() => rerunEdited(message)}>
                        保存并重跑
                      </button>
                      <button type="button" disabled={loading} onClick={() => setEditingMessageId("")}>
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <p>{message.content}</p>
                )}
                <div className="chat-message-actions">
                  <button type="button" disabled={loading} onClick={() => navigator.clipboard.writeText(message.content)}>
                    复制
                  </button>
                  {message.role === "user" && (
                    <button type="button" disabled={loading} onClick={() => startEdit(message)}>
                      编辑重跑
                    </button>
                  )}
                  <button type="button" disabled={loading} onClick={() => onBranchMessage(message.id)}>
                    分支
                  </button>
                  <button type="button" disabled={loading} onClick={() => onDeleteMessage(message.id)}>
                    删除
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
          <button type="button" onClick={onStopChat}>
            停止
          </button>
        ) : (
          <button type="button" disabled={disabled || loading || !value.trim()} onClick={onGenerate}>
            {buttonText}
          </button>
        )}
      </div>
    </aside>
  );
}
