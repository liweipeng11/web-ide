import { useEffect, useRef, useState } from "react";
import {
  applyPatch,
  branchFileChatMessage,
  clearFileChat,
  deleteFileChatMessage,
  fetchFile,
  fetchFileChat,
  fetchFileChatHistories,
  fetchFiles,
  fetchWorkspace,
  generateEdit,
  openWorkspace,
  pickWorkspace,
  rejectPatch,
  streamFileChatMessage,
  type FileChatMessage,
  type FileChatHistoryItem,
  type FileTreeNode,
  type GenerateEditResponse
} from "./api";
import ChatPanel from "./components/ChatPanel";
import DiffViewer from "./components/DiffViewer";
import EditorPane from "./components/EditorPane";
import FileTree from "./components/FileTree";

type AppState = {
  selectedPath: string | null;
  fileContent: string;
  userRequest: string;
  chatMode: "chat" | "edit";
  chatMessages: FileChatMessage[];
  chatHistories: FileChatHistoryItem[];
  loading: boolean;
  streaming: boolean;
  error: string | null;
  patch: null | GenerateEditResponse;
  workspaceRoot: string;
  workspaceInput: string;
};

const initialState: AppState = {
  selectedPath: null,
  fileContent: "",
  userRequest: "",
  chatMode: "chat",
  chatMessages: [],
  chatHistories: [],
  loading: false,
  streaming: false,
  error: null,
  patch: null,
  workspaceRoot: "",
  workspaceInput: ""
};

export default function App() {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [state, setState] = useState<AppState>(initialState);
  const [chatWidth, setChatWidth] = useState(320);
  const streamAbortController = useRef<AbortController | null>(null);
  const resizingChat = useRef(false);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!resizingChat.current) return;

      const nextWidth = Math.min(560, Math.max(240, window.innerWidth - event.clientX));
      setChatWidth(nextWidth);
    }

    function handlePointerUp() {
      resizingChat.current = false;
      document.body.classList.remove("resizing-chat");
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  useEffect(() => {
    fetchWorkspace()
      .then(async (workspace) => {
        const [nodes, histories] = workspace.workspaceRoot ? await Promise.all([fetchFiles(), fetchFileChatHistories()]) : [[], { histories: [] }];

        setFiles(nodes);
        setState((current) => ({
          ...current,
          workspaceRoot: workspace.workspaceRoot || "",
          workspaceInput: workspace.workspaceRoot || "",
          chatHistories: histories.histories
        }));
      })
      .catch((error) => setState((current) => ({ ...current, error: error.message })));
  }, []);

  async function handleOpenWorkspace() {
    const nextWorkspaceRoot = state.workspaceInput.trim();

    if (!nextWorkspaceRoot) {
      setState((current) => ({ ...current, error: "请输入项目文件夹的绝对路径。" }));
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const workspace = await openWorkspace(nextWorkspaceRoot);
      const nodes = await fetchFiles();

      setFiles(nodes);
      setState((current) => ({
        ...current,
        workspaceRoot: workspace.workspaceRoot || "",
        workspaceInput: workspace.workspaceRoot || "",
        selectedPath: null,
        fileContent: "",
        chatMessages: [],
        chatHistories: [],
        patch: null,
        loading: false,
        error: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "打开项目失败"
      }));
    }
  }

  async function handlePickWorkspace() {
    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const workspace = await pickWorkspace();

      if (workspace.cancelled) {
        setState((current) => ({ ...current, loading: false }));
        return;
      }

      const nodes = await fetchFiles();

      setFiles(nodes);
      setState((current) => ({
        ...current,
        workspaceRoot: workspace.workspaceRoot || "",
        workspaceInput: workspace.workspaceRoot || "",
        selectedPath: null,
        fileContent: "",
        chatMessages: [],
        chatHistories: [],
        patch: null,
        loading: false,
        error: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "选择项目失败"
      }));
    }
  }

  async function handleOpenFile(path: string) {
    setState((current) => ({ ...current, loading: true, error: null, patch: null }));

    try {
      const [file, chat] = await Promise.all([fetchFile(path), fetchFileChat(path)]);
      setState((current) => ({
        ...current,
        selectedPath: file.path,
        fileContent: file.content,
        chatMessages: chat.messages,
        loading: false,
        patch: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "打开文件失败"
      }));
    }
  }

  async function handleRefreshChatHistories() {
    if (!state.workspaceRoot) return;

    try {
      const data = await fetchFileChatHistories();
      setState((current) => ({ ...current, chatHistories: data.histories }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "加载聊天历史失败" }));
    }
  }

  async function handleGenerate() {
    if (!state.selectedPath) {
      setState((current) => ({ ...current, error: "请先选择一个文件。" }));
      return;
    }

    if (!state.userRequest.trim()) {
      setState((current) => ({ ...current, error: state.chatMode === "chat" ? "请先输入消息。" : "请先输入修改需求。" }));
      return;
    }

    if (state.chatMode === "chat") {
      await handleSendChatMessage(state.userRequest);
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null, patch: null }));

    try {
      const patch = await generateEdit(state.selectedPath, state.userRequest);
      setState((current) => ({ ...current, loading: false, patch }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "AI 请求失败"
      }));
    }
  }

  async function handleSendChatMessage(content: string, replayFromMessageId?: string) {
    if (!state.selectedPath || !content.trim() || state.streaming) return;

    const controller = new AbortController();
    streamAbortController.current = controller;
    setState((current) => ({ ...current, loading: true, streaming: true, error: null, patch: null, userRequest: replayFromMessageId ? current.userRequest : "" }));

    try {
      await streamFileChatMessage(
        state.selectedPath,
        content.trim(),
        (streamEvent) => {
          if (streamEvent.event === "user") {
            setState((current) => ({ ...current, chatMessages: [...current.chatMessages.filter((message) => message.id !== streamEvent.data.message.id), streamEvent.data.message] }));
          }

          if (streamEvent.event === "assistant_start") {
            setState((current) => ({ ...current, chatMessages: [...current.chatMessages.filter((message) => message.id !== streamEvent.data.message.id), streamEvent.data.message] }));
          }

          if (streamEvent.event === "delta") {
            setState((current) => ({
              ...current,
              chatMessages: current.chatMessages.map((message) => (message.id === streamEvent.data.id ? { ...message, content: message.content + streamEvent.data.delta } : message))
            }));
          }

          if (streamEvent.event === "done") {
            setState((current) => ({ ...current, chatMessages: streamEvent.data.messages }));
          }

          if (streamEvent.event === "error") {
            throw new Error(streamEvent.data.error);
          }
        },
        controller.signal,
        replayFromMessageId
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setState((current) => ({
          ...current,
          error: error instanceof Error ? error.message : "AI 请求失败"
        }));
      }
    } finally {
      streamAbortController.current = null;
      setState((current) => ({ ...current, loading: false, streaming: false }));
    }
  }

  function handleStopChat() {
    streamAbortController.current?.abort();
  }

  async function handleApply() {
    if (!state.patch) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      await applyPatch(state.patch.patchId);
      setState((current) => ({
        ...current,
        fileContent: current.patch?.newContent ?? current.fileContent,
        loading: false,
        patch: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "应用修改失败"
      }));
    }
  }

  async function handleReject() {
    if (!state.patch) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      await rejectPatch(state.patch.patchId);
      setState((current) => ({ ...current, loading: false, patch: null }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "拒绝修改失败"
      }));
    }
  }

  async function handleClearChat() {
    if (!state.selectedPath) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const chat = await clearFileChat(state.selectedPath);
      setState((current) => ({ ...current, loading: false, chatMessages: chat.messages }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "清空聊天失败"
      }));
    }
  }

  async function handleDeleteChatMessage(messageId: string) {
    if (!state.selectedPath || state.streaming) return;

    try {
      const chat = await deleteFileChatMessage(state.selectedPath, messageId);
      setState((current) => ({ ...current, chatMessages: chat.messages }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "删除消息失败" }));
    }
  }

  async function handleBranchChatMessage(messageId: string) {
    if (!state.selectedPath || state.streaming) return;

    try {
      const chat = await branchFileChatMessage(state.selectedPath, messageId);
      setState((current) => ({ ...current, chatMessages: chat.messages }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "创建分支失败" }));
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Mini AI Web Editor</h1>
          <span>{state.workspaceRoot || "未选择项目文件夹"}</span>
        </div>
        <form
          className="workspace-picker"
          onSubmit={(event) => {
            event.preventDefault();
            void handleOpenWorkspace();
          }}
        >
          <input
            value={state.workspaceInput}
            disabled={state.loading}
            placeholder="项目文件夹绝对路径"
            onChange={(event) => setState((current) => ({ ...current, workspaceInput: event.target.value }))}
          />
          <button type="button" disabled={state.loading} onClick={() => void handlePickWorkspace()}>
            打开
          </button>
        </form>
        {state.loading && <strong>处理中...</strong>}
      </header>

      {state.error && <div className="error-banner">{state.error}</div>}

      <section className="workspace-layout" style={{ gridTemplateColumns: `minmax(220px, 260px) minmax(360px, 1fr) ${chatWidth}px` }}>
        <FileTree nodes={files} selectedPath={state.selectedPath} onOpenFile={handleOpenFile} />
        <EditorPane path={state.selectedPath} value={state.fileContent} onChange={(fileContent) => setState((current) => ({ ...current, fileContent }))} />
        <div className="chat-column">
          <div
            className="chat-resizer"
            role="separator"
            aria-orientation="vertical"
            title="调整 AI 聊天宽度"
            onPointerDown={(event) => {
              event.preventDefault();
              resizingChat.current = true;
              document.body.classList.add("resizing-chat");
            }}
          />
          <ChatPanel
            value={state.userRequest}
            mode={state.chatMode}
            messages={state.chatMessages}
            histories={state.chatHistories}
            loading={state.loading}
            streaming={state.streaming}
            disabled={!state.selectedPath}
            onChange={(userRequest) => setState((current) => ({ ...current, userRequest }))}
            onModeChange={(chatMode) => setState((current) => ({ ...current, chatMode, error: null }))}
            onClearChat={handleClearChat}
            onOpenHistory={(path) => void handleOpenFile(path)}
            onRefreshHistories={() => void handleRefreshChatHistories()}
            onStopChat={handleStopChat}
            onDeleteMessage={handleDeleteChatMessage}
            onBranchMessage={handleBranchChatMessage}
            onRerunMessage={(message) => {
              setState((current) => ({ ...current, userRequest: message.content }));
              void handleSendChatMessage(message.content, message.id);
            }}
            onGenerate={handleGenerate}
          />
        </div>
      </section>

      <DiffViewer patch={state.patch} loading={state.loading} onApply={handleApply} onReject={handleReject} />
    </main>
  );
}
