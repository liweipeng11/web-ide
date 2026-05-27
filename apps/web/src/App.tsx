import { useEffect, useRef, useState } from "react";
import {
  applyPatch,
  branchFileChatMessage,
  clearFileChat,
  deleteFileChatHistory,
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
  runProjectCommand,
  saveFile,
  streamFileChatMessage,
  type CommandResult,
  type FileChatMessage,
  type FileChatHistoryItem,
  type FileTreeNode,
  type GenerateEditResponse
} from "./api";
import ChatPanel from "./components/ChatPanel";
import CodeSearchPanel from "./components/CodeSearchPanel";
import DiffViewer from "./components/DiffViewer";
import EditorPane from "./components/EditorPane";
import FileTree from "./components/FileTree";
import Icon from "./components/Icon";
import TerminalPanel from "./components/TerminalPanel";

type AppState = {
  selectedPath: string | null;
  fileContent: string;
  savedFileContent: string;
  userRequest: string;
  chatId: string;
  chatMode: "chat" | "edit";
  chatMessages: FileChatMessage[];
  chatHistories: FileChatHistoryItem[];
  chatContextPaths: string[];
  loading: boolean;
  streaming: boolean;
  error: string | null;
  patch: null | GenerateEditResponse;
  workspaceRoot: string;
  workspaceInput: string;
  showIgnoredFiles: boolean;
};

type CommandSuggestion = {
  command: string;
  reason?: string;
  risk?: string;
};

function collectFilePaths(nodes: FileTreeNode[]): string[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node.path] : collectFilePaths(node.children || [])));
}

function createChatId() {
  return `chat:${crypto.randomUUID()}`;
}

const initialState: AppState = {
  selectedPath: null,
  fileContent: "",
  savedFileContent: "",
  userRequest: "",
  chatId: createChatId(),
  chatMode: "chat",
  chatMessages: [],
  chatHistories: [],
  chatContextPaths: [],
  loading: false,
  streaming: false,
  error: null,
  patch: null,
  workspaceRoot: "",
  workspaceInput: "",
  showIgnoredFiles: false
};

export default function App() {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [state, setState] = useState<AppState>(initialState);
  const [chatWidth, setChatWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [leftPanel, setLeftPanel] = useState<"files" | "search">("files");
  const [savingFile, setSavingFile] = useState(false);
  const streamAbortController = useRef<AbortController | null>(null);
  const resizingChat = useRef(false);
  const resizingTerminal = useRef(false);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (resizingChat.current) {
        const nextWidth = Math.min(560, Math.max(240, window.innerWidth - event.clientX));
        setChatWidth(nextWidth);
      }

      if (resizingTerminal.current) {
        const nextHeight = Math.min(Math.floor(window.innerHeight * 0.55), Math.max(120, window.innerHeight - event.clientY));
        setTerminalHeight(nextHeight);
      }
    }

    function handlePointerUp() {
      resizingChat.current = false;
      resizingTerminal.current = false;
      document.body.classList.remove("resizing-chat");
      document.body.classList.remove("resizing-terminal");
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
        const [nodes, histories] = workspace.workspaceRoot ? await Promise.all([fetchFiles("", false), fetchFileChatHistories()]) : [[], { histories: [] }];

        setFiles(nodes);
        setState((current) => ({
          ...current,
          workspaceRoot: workspace.workspaceRoot || "",
          workspaceInput: workspace.workspaceRoot || "",
          chatHistories: histories.histories,
          chatMessages: []
        }));
      })
      .catch((error) => setState((current) => ({ ...current, error: error.message })));
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isTerminalShortcut = (event.ctrlKey || event.metaKey) && (event.key === "`" || event.code === "Backquote");

      if (!isTerminalShortcut || event.repeat) return;

      event.preventDefault();
      resizingTerminal.current = false;
      document.body.classList.remove("resizing-terminal");
      setTerminalOpen((current) => !current);
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSearchShortcut = (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f";

      if (!isSearchShortcut) return;

      setLeftPanel("search");
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
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
      const [nodes, histories] = await Promise.all([fetchFiles("", state.showIgnoredFiles), fetchFileChatHistories()]);

      setFiles(nodes);
      setState((current) => ({
        ...current,
        workspaceRoot: workspace.workspaceRoot || "",
        workspaceInput: workspace.workspaceRoot || "",
        selectedPath: null,
        fileContent: "",
        savedFileContent: "",
        chatId: createChatId(),
        chatMessages: [],
        chatHistories: histories.histories,
        chatContextPaths: [],
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

      const [nodes, histories] = await Promise.all([fetchFiles("", state.showIgnoredFiles), fetchFileChatHistories()]);

      setFiles(nodes);
      setState((current) => ({
        ...current,
        workspaceRoot: workspace.workspaceRoot || "",
        workspaceInput: workspace.workspaceRoot || "",
        selectedPath: null,
        fileContent: "",
        savedFileContent: "",
        chatId: createChatId(),
        chatMessages: [],
        chatHistories: histories.histories,
        chatContextPaths: [],
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
      const file = await fetchFile(path, state.showIgnoredFiles);
      setState((current) => ({
        ...current,
        selectedPath: file.path,
        fileContent: file.content,
        savedFileContent: file.content,
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

  async function handleToggleShowIgnored(showIgnoredFiles: boolean) {
    if (!state.workspaceRoot) {
      setState((current) => ({ ...current, showIgnoredFiles }));
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null, showIgnoredFiles }));

    try {
      const nodes = await fetchFiles("", showIgnoredFiles);
      setFiles(nodes);
      setState((current) => ({ ...current, loading: false }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "加载文件树失败"
      }));
    }
  }

  async function handleOpenChatHistory(chatId: string) {
    if (!state.workspaceRoot) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const chat = await fetchFileChat(chatId);
      setState((current) => ({
        ...current,
        chatId,
        chatMessages: chat.messages,
        loading: false,
        error: null
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "加载聊天历史失败"
      }));
    }
  }

  function handleNewChat() {
    streamAbortController.current?.abort();
    setState((current) => ({
      ...current,
      chatId: createChatId(),
      chatMessages: [],
      chatContextPaths: [],
      userRequest: "",
      patch: null,
      error: null
    }));
  }

  async function handleDeleteChatHistory(path: string) {
    if (!state.workspaceRoot || state.loading) return;

    setState((current) => ({ ...current, error: null }));

    try {
      const data = await deleteFileChatHistory(path);
      setState((current) => ({
        ...current,
        chatHistories: data.histories,
        chatMessages: path === current.chatId ? [] : current.chatMessages
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "删除聊天历史失败" }));
    }
  }

  async function handleSaveFile() {
    if (!state.selectedPath || savingFile || state.fileContent === state.savedFileContent) return;

    const pathToSave = state.selectedPath;
    const contentToSave = state.fileContent;
    setSavingFile(true);
    setState((current) => ({ ...current, error: null }));

    try {
      await saveFile(pathToSave, contentToSave);
      setState((current) => {
        if (current.selectedPath !== pathToSave) return current;

        return {
          ...current,
          savedFileContent: contentToSave,
          error: null
        };
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "保存文件失败"
      }));
    } finally {
      setSavingFile(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";

      if (!isSaveShortcut || event.repeat) return;

      event.preventDefault();
      void handleSaveFile();
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [savingFile, state.fileContent, state.savedFileContent, state.selectedPath]);

  async function handleGenerate() {
    if (state.chatMode === "edit" && !state.selectedPath) {
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

    const pathToEdit = state.selectedPath;

    if (!pathToEdit) return;
    setState((current) => ({ ...current, loading: true, error: null, patch: null }));

    try {
      const patch = await generateEdit(pathToEdit, state.userRequest);
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
    if (!state.workspaceRoot || !content.trim() || state.streaming) return;

    const controller = new AbortController();
    streamAbortController.current = controller;
    setState((current) => ({ ...current, loading: true, streaming: true, error: null, patch: null, userRequest: replayFromMessageId ? current.userRequest : "" }));

    try {
      await streamFileChatMessage(
        content.trim(),
        state.chatContextPaths,
        state.chatId,
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

    const patchToApply = state.patch;
    const selectedPathToApply = state.selectedPath;
    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      await applyPatch(patchToApply.patchId);
      setState((current) => ({
        ...current,
        fileContent: current.selectedPath === selectedPathToApply ? patchToApply.newContent : current.fileContent,
        savedFileContent: current.selectedPath === selectedPathToApply ? patchToApply.newContent : current.savedFileContent,
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
    if (!state.workspaceRoot) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const chat = await clearFileChat(state.chatId);
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
    if (!state.workspaceRoot || state.streaming) return;

    try {
      const chat = await deleteFileChatMessage(state.chatId, messageId);
      setState((current) => ({ ...current, chatMessages: chat.messages }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "删除消息失败" }));
    }
  }

  async function handleBranchChatMessage(messageId: string) {
    if (!state.workspaceRoot || state.streaming) return;

    try {
      const chat = await branchFileChatMessage(state.chatId, messageId);
      setState((current) => ({ ...current, chatMessages: chat.messages }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "创建分支失败" }));
    }
  }

  function formatCommandResultForAi(result: CommandResult) {
    const output = [result.stderr && `stderr:\n${result.stderr}`, result.stdout && `stdout:\n${result.stdout}`].filter(Boolean).join("\n\n");

    return [
      "命令已由用户确认并执行，请分析结果并给出下一步建议。",
      "",
      `命令：${result.command}`,
      `工作目录：${result.cwd}`,
      `退出码：${result.exitCode ?? "null"}`,
      "",
      "输出：",
      output || "(无输出)"
    ].join("\n");
  }

  async function handleRunCommandSuggestion(suggestion: CommandSuggestion) {
    if (!state.workspaceRoot || state.loading || state.streaming) return null;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const { result } = await runProjectCommand(suggestion.command, undefined, state.chatId);
      setState((current) => ({ ...current, loading: false }));
      await handleSendChatMessage(formatCommandResultForAi(result));
      return result;
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "命令执行失败"
      }));
      return null;
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
          <button type="button" className="icon-button" disabled={state.loading} title="选择项目" aria-label="选择项目" onClick={() => void handlePickWorkspace()}>
            <Icon name="folder-open" />
          </button>
        </form>
        <button
          type="button"
          className="terminal-toggle icon-button"
          title="切换终端 (Ctrl+`)"
          aria-label="切换终端"
          aria-pressed={terminalOpen}
          onClick={() => setTerminalOpen((current) => !current)}
        >
          <Icon name="terminal" />
        </button>
        {state.loading && <strong>处理中...</strong>}
      </header>

      {state.error && <div className="error-banner">{state.error}</div>}

      <section className="workbench">
        <section className="workspace-layout" style={{ gridTemplateColumns: `48px minmax(220px, 260px) minmax(360px, 1fr) ${chatWidth}px` }}>
          <nav className="activity-bar" aria-label="Primary">
            <button type="button" className={leftPanel === "files" ? "active" : ""} title="文件树" aria-label="文件树" aria-pressed={leftPanel === "files"} onClick={() => setLeftPanel("files")}>
              <Icon name="folder-open" />
            </button>
            <button type="button" className={leftPanel === "search" ? "active" : ""} title="代码搜索 (Ctrl+Shift+F)" aria-label="代码搜索" aria-pressed={leftPanel === "search"} onClick={() => setLeftPanel("search")}>
              <Icon name="search" />
            </button>
          </nav>
          <aside className="left-sidebar">
            {leftPanel === "files" ? (
              <FileTree
                nodes={files}
                selectedPath={state.selectedPath}
                showIgnored={state.showIgnoredFiles}
                onOpenFile={handleOpenFile}
                onToggleShowIgnored={(showIgnored) => void handleToggleShowIgnored(showIgnored)}
              />
            ) : (
              <CodeSearchPanel disabled={!state.workspaceRoot} onOpenFile={handleOpenFile} />
            )}
          </aside>
        <div className="editor-column">
          <EditorPane
            path={state.selectedPath}
            value={state.fileContent}
            dirty={state.fileContent !== state.savedFileContent}
            saving={savingFile}
            onSave={() => void handleSaveFile()}
            onChange={(fileContent) => setState((current) => ({ ...current, fileContent }))}
          />
          {terminalOpen && (
            <TerminalPanel
              workspaceRoot={state.workspaceRoot}
              height={terminalHeight}
              onClose={() => {
                resizingTerminal.current = false;
                document.body.classList.remove("resizing-terminal");
                setTerminalOpen(false);
              }}
              onStartResize={(event) => {
                event.preventDefault();
                resizingTerminal.current = true;
                document.body.classList.add("resizing-terminal");
              }}
            />
          )}
        </div>
        <div className="chat-column">
          <div
            className="chat-resizer"
            role="separator"
            aria-orientation="vertical"
            title="璋冩暣 AI 鑱婂ぉ瀹藉害"
            onPointerDown={(event) => {
              event.preventDefault();
              resizingChat.current = true;
              document.body.classList.add("resizing-chat");
            }}
          />
          <ChatPanel
            value={state.userRequest}
            chatId={state.chatId}
            mode={state.chatMode}
            messages={state.chatMessages}
            histories={state.chatHistories}
            availableFiles={collectFilePaths(files)}
            contextPaths={state.chatContextPaths}
            loading={state.loading}
            streaming={state.streaming}
            disabled={!state.workspaceRoot}
            onChange={(userRequest) => setState((current) => ({ ...current, userRequest }))}
            onModeChange={(chatMode) => setState((current) => ({ ...current, chatMode, error: null }))}
            onClearChat={handleClearChat}
            onOpenHistory={(path) => void handleOpenChatHistory(path)}
            onRefreshHistories={() => void handleRefreshChatHistories()}
            onNewChat={handleNewChat}
            onDeleteHistory={(path) => void handleDeleteChatHistory(path)}
            onAddContextPath={(path) =>
              setState((current) => ({
                ...current,
                chatContextPaths: current.chatContextPaths.includes(path) ? current.chatContextPaths : [...current.chatContextPaths, path]
              }))
            }
            onRemoveContextPath={(path) =>
              setState((current) => ({
                ...current,
                chatContextPaths: current.chatContextPaths.filter((item) => item !== path)
              }))
            }
            onStopChat={handleStopChat}
            onDeleteMessage={handleDeleteChatMessage}
            onBranchMessage={handleBranchChatMessage}
            onRunCommandSuggestion={(suggestion) => handleRunCommandSuggestion(suggestion)}
            onRerunMessage={(message) => {
              setState((current) => ({ ...current, userRequest: message.content }));
              void handleSendChatMessage(message.content, message.id);
            }}
            onGenerate={handleGenerate}
          />
        </div>
        </section>
      </section>

      <DiffViewer patch={state.patch} loading={state.loading} onApply={handleApply} onReject={handleReject} />
    </main>
  );
}



