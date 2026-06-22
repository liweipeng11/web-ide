import { useEffect, useRef, useState } from "react";
import {
  applyPatch,
  approveTaskPlan,
  branchFileChatMessage,
  clearFileChat,
  createTaskPlanItem,
  deleteTaskPlanItem,
  deleteFileChatHistory,
  deleteFileChatMessage,
  fetchCommandPolicy,
  fetchCheckpoint,
  fetchFile,
  fetchFileChat,
  fetchFileChatHistories,
  fetchFiles,
  fetchProjectRules,
  fetchTaskSession,
  fetchTaskSessions,
  fetchWorkspace,
  openWorkspace,
  pickWorkspace,
  recordTaskSessionCommand,
  rejectPatch,
  rollbackCheckpoint,
  saveFile,
  streamGenerateEdit,
  streamFileChatMessage,
  rewriteTaskPlan,
  updateTaskPlanItem,
  validateAndFix,
  type AutoValidationResponse,
  type CommandResult,
  type FileTreeNode,
  type TaskPlanItemStatus,
  type TaskSession
} from "./api";
import { createChatId, createClientErrorStep, createCommandAgentStep, initialState, type AppState, type CommandSuggestion } from "./appState";
import AppLayout from "./components/AppLayout";
import type { TerminalCommandCompletion, TerminalCommandRequest } from "./components/TerminalPanel";

const MAX_FIX_ATTEMPTS = 3;
const commandOutputPreviewChars = 2000;

export default function App() {
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [state, setState] = useState<AppState>(initialState);
  const [chatWidth, setChatWidth] = useState(320);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalCommandRequest, setTerminalCommandRequest] = useState<TerminalCommandRequest | null>(null);
  const [leftPanel, setLeftPanel] = useState<"files" | "search" | "rules" | "git">("files");
  const [savingFile, setSavingFile] = useState(false);
  const streamAbortController = useRef<AbortController | null>(null);
  const pendingChatDeltas = useRef<Record<string, string>>({});
  const pendingChatDeltaTimer = useRef<number | null>(null);
  const terminalCommandResolvers = useRef<Record<string, (result: CommandResult | null) => void>>({});
  const terminalCommandTaskSessions = useRef<Record<string, string | null>>({});
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
        const [nodes, histories, taskHistory, projectRules] = workspace.workspaceRoot
          ? await Promise.all([fetchFiles("", false), fetchFileChatHistories(), fetchTaskSessions(), fetchProjectRules()])
          : [[], { histories: [] }, { sessions: [] }, null];

        setFiles(nodes);
        setState((current) => ({
          ...current,
          workspaceRoot: workspace.workspaceRoot || "",
          workspaceInput: workspace.workspaceRoot || "",
          chatHistories: histories.histories,
          taskSessions: taskHistory.sessions,
          projectRules,
          selectedTaskSession: null,
          chatMessages: [],
          agentSteps: []
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
      const [nodes, histories, taskHistory, projectRules] = await Promise.all([fetchFiles("", state.showIgnoredFiles), fetchFileChatHistories(), fetchTaskSessions(), fetchProjectRules()]);

      setFiles(nodes);
      setState((current) => ({
        ...current,
        workspaceRoot: workspace.workspaceRoot || "",
        workspaceInput: workspace.workspaceRoot || "",
        selectedPath: null,
        fileContent: "",
        savedFileContent: "",
        openFiles: [],
        chatId: createChatId(),
        chatMessages: [],
        agentSteps: [],
        chatHistories: histories.histories,
        currentTaskSessionId: null,
        taskSessions: taskHistory.sessions,
        projectRules,
        selectedTaskSession: null,
        chatContextPaths: [],
        patch: null,
        autoFix: null,
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

      const [nodes, histories, taskHistory, projectRules] = await Promise.all([fetchFiles("", state.showIgnoredFiles), fetchFileChatHistories(), fetchTaskSessions(), fetchProjectRules()]);

      setFiles(nodes);
      setState((current) => ({
        ...current,
        workspaceRoot: workspace.workspaceRoot || "",
        workspaceInput: workspace.workspaceRoot || "",
        selectedPath: null,
        fileContent: "",
        savedFileContent: "",
        openFiles: [],
        chatId: createChatId(),
        chatMessages: [],
        agentSteps: [],
        chatHistories: histories.histories,
        currentTaskSessionId: null,
        taskSessions: taskHistory.sessions,
        projectRules,
        selectedTaskSession: null,
        chatContextPaths: [],
        patch: null,
        autoFix: null,
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
    const openFile = state.openFiles.find((file) => file.path === path);

    if (openFile) {
      setState((current) => ({
        ...current,
        selectedPath: openFile.path,
        fileContent: openFile.content,
        savedFileContent: openFile.savedContent,
        error: null,
        patch: null
      }));
      return;
    }

    setState((current) => ({ ...current, loading: true, error: null, patch: null }));

    try {
      const file = await fetchFile(path, state.showIgnoredFiles);
      setState((current) => ({
        ...current,
        selectedPath: file.path,
        fileContent: file.content,
        savedFileContent: file.content,
        openFiles: [...current.openFiles.filter((openFile) => openFile.path !== file.path), { path: file.path, content: file.content, savedContent: file.content }],
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

  async function refreshTaskSessions(selectedTaskSessionId?: string | null) {
    if (!state.workspaceRoot) return;

    const taskHistory = await fetchTaskSessions();
    const selectedTaskSession = selectedTaskSessionId ? await fetchTaskSession(selectedTaskSessionId).then((data) => data.session).catch(() => null) : null;
    setState((current) => ({
      ...current,
      taskSessions: taskHistory.sessions,
      selectedTaskSession: selectedTaskSessionId ? selectedTaskSession : current.selectedTaskSession
    }));
  }

  // 计划项更新后同步任务列表和详情，避免两个区域显示不同版本。
  function mergeTaskSession(session: TaskSession) {
    setState((current) => ({
      ...current,
      taskSessions: [session, ...current.taskSessions.filter((item) => item.id !== session.id)].sort((left, right) => right.createdAt - left.createdAt),
      selectedTaskSession: current.selectedTaskSession?.id === session.id ? session : current.selectedTaskSession
    }));
  }

  async function handleAddPlanItem(taskSessionId: string, title: string) {
    if (!state.workspaceRoot || state.loading) return;

    try {
      const { session } = await createTaskPlanItem(taskSessionId, title);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "添加计划步骤失败" }));
    }
  }

  async function handleUpdatePlanItem(taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) {
    if (!state.workspaceRoot || state.loading) return;

    try {
      const { session } = await updateTaskPlanItem(taskSessionId, planItemId, updates);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "更新计划步骤失败" }));
    }
  }

  async function handleDeletePlanItem(taskSessionId: string, planItemId: string) {
    if (!state.workspaceRoot || state.loading) return;

    try {
      const { session } = await deleteTaskPlanItem(taskSessionId, planItemId);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "删除计划步骤失败" }));
    }
  }

  async function handleRewritePlan(taskSessionId: string, instruction: string) {
    if (!state.workspaceRoot || state.loading || !instruction.trim()) return;

    try {
      const { session } = await rewriteTaskPlan(taskSessionId, instruction);
      mergeTaskSession(session);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "调整计划失败" }));
    }
  }

  async function handleApprovePlan(taskSessionId: string) {
    if (!state.workspaceRoot || state.loading || state.streaming) return;

    try {
      const { session } = await approveTaskPlan(taskSessionId);
      if (!session) return;
      mergeTaskSession(session);
      await handleSendChatMessage(session.userGoal, undefined, session.id);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "批准计划失败" }));
    }
  }

  async function handleOpenTaskSession(taskSessionId: string) {
    if (!state.workspaceRoot) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const [{ sessions }, { session }] = await Promise.all([fetchTaskSessions(), fetchTaskSession(taskSessionId)]);
      setState((current) => ({ ...current, loading: false, taskSessions: sessions, selectedTaskSession: session, error: null }));
    } catch (error) {
      setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "加载任务历史失败" }));
    }
  }

  async function handleRefreshTaskSessions() {
    try {
      await refreshTaskSessions(state.selectedTaskSession?.id || null);
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "刷新任务历史失败" }));
    }
  }

  async function handleRefreshProjectRules() {
    if (!state.workspaceRoot) return;

    try {
      const projectRules = await fetchProjectRules(state.selectedPath ? [state.selectedPath] : state.chatContextPaths);
      setState((current) => ({ ...current, projectRules }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "加载项目规则失败" }));
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
        agentSteps: [],
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
      agentSteps: [],
      chatContextPaths: [],
      userRequest: "",
      patch: null,
      autoFix: null,
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
          openFiles: current.openFiles.map((file) => (file.path === pathToSave ? { ...file, content: contentToSave, savedContent: contentToSave } : file)),
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

  function handleSelectOpenFile(path: string) {
    const openFile = state.openFiles.find((file) => file.path === path);
    if (!openFile) return;

    setState((current) => ({
      ...current,
      selectedPath: openFile.path,
      fileContent: openFile.content,
      savedFileContent: openFile.savedContent,
      error: null
    }));
  }

  function handleCloseOpenFile(path: string) {
    setState((current) => {
      const closingIndex = current.openFiles.findIndex((file) => file.path === path);
      const openFiles = current.openFiles.filter((file) => file.path !== path);

      if (current.selectedPath !== path) {
        return { ...current, openFiles };
      }

      const nextFile = openFiles[Math.min(closingIndex, openFiles.length - 1)] || null;

      return {
        ...current,
        selectedPath: nextFile?.path || null,
        fileContent: nextFile?.content || "",
        savedFileContent: nextFile?.savedContent || "",
        openFiles,
        patch: null
      };
    });
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
    if (!state.userRequest.trim()) {
      setState((current) => ({ ...current, error: "请先输入消息或修改需求。" }));
      return;
    }

    await handleSendChatMessage(state.userRequest);
  }

  async function handleSendChatMessage(content: string, replayFromMessageId?: string, approvedTaskSessionId?: string) {
    if (!state.workspaceRoot || !content.trim() || state.streaming) return;

    function flushPendingChatDeltas() {
      const pending = pendingChatDeltas.current;

      if (!Object.keys(pending).length) return;

      pendingChatDeltas.current = {};
      setState((current) => ({
        ...current,
        chatMessages: current.chatMessages.map((message) => {
          const delta = pending[message.id];
          return delta ? { ...message, content: message.content + delta } : message;
        })
      }));
    }

    function clearPendingChatDeltaTimer() {
      if (pendingChatDeltaTimer.current !== null) {
        window.clearTimeout(pendingChatDeltaTimer.current);
        pendingChatDeltaTimer.current = null;
      }
    }

    function queueChatDelta(messageId: string, delta: string) {
      pendingChatDeltas.current = {
        ...pendingChatDeltas.current,
        [messageId]: `${pendingChatDeltas.current[messageId] || ""}${delta}`
      };

      if (pendingChatDeltaTimer.current !== null) return;

      pendingChatDeltaTimer.current = window.setTimeout(() => {
        pendingChatDeltaTimer.current = null;
        flushPendingChatDeltas();
      }, 80);
    }

    const controller = new AbortController();
    streamAbortController.current = controller;
    clearPendingChatDeltaTimer();
    pendingChatDeltas.current = {};
    setState((current) => ({ ...current, loading: true, streaming: true, error: null, patch: null, agentSteps: [], userRequest: replayFromMessageId ? current.userRequest : "" }));

    let streamTaskSessionId: string | null = null;

    try {
      await streamFileChatMessage(
        content.trim(),
        state.chatContextPaths,
        state.chatId,
        (streamEvent) => {
          if (streamEvent.event === "task_session") {
            streamTaskSessionId = streamEvent.data.session.id;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.session.id,
              taskSessions: [streamEvent.data.session, ...current.taskSessions.filter((session) => session.id !== streamEvent.data.session.id)]
            }));
          }

          if (streamEvent.event === "chat" && streamEvent.data.taskSessionId) {
            streamTaskSessionId = streamEvent.data.taskSessionId;
            setState((current) => ({ ...current, currentTaskSessionId: streamEvent.data.taskSessionId || current.currentTaskSessionId }));
          }

          if (streamEvent.event === "user") {
            setState((current) => ({ ...current, chatMessages: [...current.chatMessages.filter((message) => message.id !== streamEvent.data.message.id), streamEvent.data.message] }));
          }

          if (streamEvent.event === "assistant_start") {
            setState((current) => ({ ...current, chatMessages: [...current.chatMessages.filter((message) => message.id !== streamEvent.data.message.id), streamEvent.data.message] }));
          }

          if (streamEvent.event === "delta") {
            queueChatDelta(streamEvent.data.id, streamEvent.data.delta);
          }

          if (streamEvent.event === "agent_step") {
            setState((current) => ({
              ...current,
              agentSteps: [...current.agentSteps.filter((step) => step.id !== streamEvent.data.step.id), streamEvent.data.step]
            }));
          }

          if (streamEvent.event === "patch") {
            streamTaskSessionId = streamEvent.data.patch.taskSessionId || streamTaskSessionId;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.patch.taskSessionId || current.currentTaskSessionId,
              patch: streamEvent.data.patch,
              autoFix: null,
              agentSteps: streamEvent.data.patch.agentSteps || current.agentSteps
            }));
          }

          if (streamEvent.event === "done") {
            clearPendingChatDeltaTimer();
            pendingChatDeltas.current = {};
            setState((current) => ({ ...current, chatMessages: streamEvent.data.messages }));
            void refreshTaskSessions(streamTaskSessionId);
          }

          if (streamEvent.event === "error") {
            throw new Error(streamEvent.data.error);
          }
        },
        controller.signal,
        replayFromMessageId,
        state.selectedPath,
        approvedTaskSessionId
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : "AI request failed";
        setState((current) => ({
          ...current,
          error: message,
          agentSteps: [...current.agentSteps, createClientErrorStep(message)]
        }));
      }
    } finally {
      clearPendingChatDeltaTimer();
      flushPendingChatDeltas();
      streamAbortController.current = null;
      void refreshTaskSessions(streamTaskSessionId);
      setState((current) => ({ ...current, loading: false, streaming: false }));
    }
  }

  function handleStopChat() {
    streamAbortController.current?.abort();
  }

  async function handleValidateAndFix(command: string, options: { confirmed?: boolean } = {}): Promise<AutoValidationResponse | null> {
    if (!state.workspaceRoot || state.loading || state.streaming) return null;

    const currentAutoFix = state.autoFix?.command === command ? state.autoFix : null;
    const attempts = currentAutoFix?.attempts || 0;
    const maxAttempts = currentAutoFix?.maxAttempts || MAX_FIX_ATTEMPTS;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const validation = await validateAndFix(command, {
        selectedPath: state.selectedPath,
        taskSessionId: state.currentTaskSessionId,
        attempts,
        maxAttempts,
        confirmed: options.confirmed
      });

      if (validation.status === "needs_confirmation") {
        const confirmed = window.confirm(`该验证命令需要确认后执行：\n\n${validation.command}\n\n原因：${validation.policy.reason}\n\n确认执行？`);
        setState((current) => ({ ...current, loading: false }));
        return confirmed ? handleValidateAndFix(command, { confirmed: true }) : null;
      }

      const nextAgentSteps = (currentSteps: AppState["agentSteps"]) => [...currentSteps, ...validation.agentSteps.filter((step) => !currentSteps.some((item) => item.id === step.id))];
      const failureSummary = validation.failureSummary || validation.result?.summary || "";

      if (validation.status === "fix_generated" && validation.patch) {
        const fixPatch = validation.patch;
        setState((current) => ({
          ...current,
          loading: false,
          error: null,
          currentTaskSessionId: fixPatch.taskSessionId || current.currentTaskSessionId,
          patch: fixPatch,
          autoFix: {
            command: validation.command,
            attempts: validation.attempts,
            maxAttempts: validation.maxAttempts,
            awaitingPatchId: fixPatch.patchId,
            lastFailureSummary: failureSummary
          },
          agentSteps: nextAgentSteps(fixPatch.agentSteps || current.agentSteps)
        }));
        void refreshTaskSessions(fixPatch.taskSessionId || state.currentTaskSessionId);
        return validation;
      }

      if (validation.status === "success") {
        setState((current) => ({
          ...current,
          loading: false,
          error: null,
          autoFix: null,
          agentSteps: nextAgentSteps(current.agentSteps)
        }));
        void refreshTaskSessions(state.currentTaskSessionId);
        return validation;
      }

      const message =
        validation.status === "blocked"
          ? validation.policy.reason
          : [`自动修复已停止：${validation.command} 连续失败，已达到最多 ${validation.maxAttempts} 次修复尝试。`, "", failureSummary].filter(Boolean).join("\n");

      setState((current) => ({
        ...current,
        loading: false,
        error: message,
        autoFix: {
          command: validation.command,
          attempts: validation.attempts,
          maxAttempts: validation.maxAttempts,
          awaitingPatchId: null,
          lastFailureSummary: failureSummary
        },
        agentSteps: nextAgentSteps(current.agentSteps)
      }));
      void refreshTaskSessions(state.currentTaskSessionId);
      return validation;
    } catch (error) {
      const message = error instanceof Error ? error.message : "自动验证失败";
      setState((current) => ({
        ...current,
        loading: false,
        error: message,
        agentSteps: [...current.agentSteps, createClientErrorStep(message)]
      }));
      return null;
    }
  }

  async function handleApply(filePath?: string) {
    if (!state.patch) return;

    const patchToApply = state.patch;
    const selectedPathToApply = state.selectedPath;
    const targetFiles = filePath ? patchToApply.files.filter((file) => file.path === filePath) : patchToApply.files;

    if (!targetFiles.length) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const result = await applyPatch(patchToApply.patchId, filePath);
      const nodes = targetFiles.some((file) => file.status === "create") ? await fetchFiles("", state.showIgnoredFiles) : null;
      if (nodes) {
        setFiles(nodes);
      }
      void refreshTaskSessions(patchToApply.taskSessionId || state.currentTaskSessionId);
      const remainingFiles = filePath ? patchToApply.files.filter((file) => file.path !== filePath) : [];
      const validationCommand = !remainingFiles.length ? state.autoFix?.awaitingPatchId === patchToApply.patchId ? state.autoFix.command : patchToApply.commandsToRun?.[0] || null : null;
      setState((current) => {
        const selectedFileChange = targetFiles.find((file) => file.path === current.selectedPath);
        const fallbackSelectedChange = current.selectedPath === selectedPathToApply && !filePath ? patchToApply : null;
        const nextSelectedContent = selectedFileChange?.newContent ?? fallbackSelectedChange?.newContent;

        return {
          ...current,
          fileContent: nextSelectedContent ?? current.fileContent,
          savedFileContent: nextSelectedContent ?? current.savedFileContent,
          openFiles: current.openFiles.map((openFile) => {
            const appliedFile = targetFiles.find((file) => file.path === openFile.path);
            return appliedFile ? { ...openFile, content: appliedFile.newContent, savedContent: appliedFile.newContent } : openFile;
          }),
          loading: false,
          lastCheckpoint: result.checkpoint,
          patch: remainingFiles.length
            ? {
                ...patchToApply,
                files: remainingFiles,
                oldContent: remainingFiles[0].oldContent,
                newContent: remainingFiles[0].newContent,
                diffHtml: remainingFiles.map((file) => '<div class="diff-file-header">' + file.path + "</div>" + file.diffHtml).join("")
              }
            : null
        };
      });

      if (validationCommand) {
        await handleValidateAndFix(validationCommand);
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "应用修改失败"
      }));
    }
  }

  async function rollbackCheckpointAndRefresh(checkpointId: string) {
    const { checkpoint } = await fetchCheckpoint(checkpointId);
    const fileList = checkpoint.files.map((file) => "- " + file.filePath).join("\n");
    const confirmed = window.confirm("即将恢复以下文件到本次智能体修改前：\n\n" + fileList + "\n\n确认撤销本次修改？");

    if (!confirmed) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      await rollbackCheckpoint(checkpoint.id);
      const nodes = await fetchFiles("", state.showIgnoredFiles);
      setFiles(nodes);

      const selectedFile = state.selectedPath ? checkpoint.files.find((file) => file.filePath === state.selectedPath) : null;
      const removedSelectedFile = selectedFile?.beforeExists === false;
      const taskSessionToRefresh = state.selectedTaskSession?.id || state.currentTaskSessionId;

      setState((current) => ({
        ...current,
        selectedPath: removedSelectedFile ? null : current.selectedPath,
        fileContent: selectedFile && !removedSelectedFile ? selectedFile.beforeContent : removedSelectedFile ? "" : current.fileContent,
        savedFileContent: selectedFile && !removedSelectedFile ? selectedFile.beforeContent : removedSelectedFile ? "" : current.savedFileContent,
        openFiles: current.openFiles
          .filter((file) => !checkpoint.files.some((checkpointFile) => checkpointFile.beforeExists === false && checkpointFile.filePath === file.path))
          .map((file) => {
            const checkpointFile = checkpoint.files.find((item) => item.filePath === file.path);
            return checkpointFile ? { ...file, content: checkpointFile.beforeContent, savedContent: checkpointFile.beforeContent } : file;
          }),
        loading: false,
        error: null,
        lastCheckpoint: current.lastCheckpoint?.id === checkpoint.id ? null : current.lastCheckpoint
      }));
      void refreshTaskSessions(taskSessionToRefresh);
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "撤销本次修改失败"
      }));
    }
  }

  async function handleRollbackLastCheckpoint() {
    if (!state.lastCheckpoint) return;
    await rollbackCheckpointAndRefresh(state.lastCheckpoint.id);
  }

  async function handleReject(filePath?: string) {
    if (!state.patch) return;

    const patchToReject = state.patch;
    const targetFiles = filePath ? patchToReject.files.filter((file) => file.path === filePath) : patchToReject.files;

    if (!targetFiles.length) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      await rejectPatch(patchToReject.patchId, filePath);
      const remainingFiles = filePath ? patchToReject.files.filter((file) => file.path !== filePath) : [];
      setState((current) => ({
        ...current,
        loading: false,
        autoFix: current.autoFix?.awaitingPatchId === patchToReject.patchId && !remainingFiles.length ? null : current.autoFix,
        patch: remainingFiles.length
          ? {
              ...patchToReject,
              files: remainingFiles,
              oldContent: remainingFiles[0].oldContent,
              newContent: remainingFiles[0].newContent,
              diffHtml: remainingFiles.map((file) => '<div class="diff-file-header">' + file.path + "</div>" + file.diffHtml).join("")
            }
          : null
      }));
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
      setState((current) => ({ ...current, loading: false, chatMessages: chat.messages, agentSteps: [] }));
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
      setState((current) => ({ ...current, chatMessages: chat.messages, agentSteps: [] }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "删除消息失败" }));
    }
  }

  async function handleBranchChatMessage(messageId: string) {
    if (!state.workspaceRoot || state.streaming) return;

    try {
      const chat = await branchFileChatMessage(state.chatId, messageId);
      setState((current) => ({ ...current, chatMessages: chat.messages, agentSteps: [] }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "创建分支失败" }));
    }
  }

  function summarizeCommandFailure(result: CommandResult) {
    const outputPreview = [
      result.summary && "summary:\n" + result.summary.slice(-commandOutputPreviewChars),
      result.stderr && "stderr tail:\n" + result.stderr.slice(-commandOutputPreviewChars),
      result.stdout && "stdout tail:\n" + result.stdout.slice(-commandOutputPreviewChars)
    ]
      .filter(Boolean)
      .join("\n\n");

    return [
      `Command: ${result.command}`,
      `CWD: ${result.cwd}`,
      `Status: ${result.status || "unknown"}`,
      `Exit code: ${result.exitCode ?? "null"}`,
      "",
      outputPreview || "(no output)"
    ].join("\n");
  }

  function buildAutoFixPrompt(result: CommandResult, nextAttempt: number) {
    return [
      `自动修复验证失败。请根据下面的错误日志生成一个新的修复 patch。`,
      "",
      `限制：这是第 ${nextAttempt} 次修复尝试，最多 ${MAX_FIX_ATTEMPTS} 次。`,
      `验证命令：${result.command}`,
      "",
      "要求：",
      "- 只修改导致验证失败的相关代码。",
      "- 返回可审查的 patch，不要声称已经运行命令。",
      "- commandsToRun 必须包含同一条验证命令。",
      "",
      "失败日志：",
      summarizeCommandFailure(result)
    ].join("\n");
  }

  async function generateAutoFixPatch(result: CommandResult) {
    const currentAutoFix = state.autoFix?.command === result.command ? state.autoFix : null;
    const nextAttempt = (currentAutoFix?.attempts || 0) + 1;
    const failureSummary = summarizeCommandFailure(result);

    if (nextAttempt > MAX_FIX_ATTEMPTS) {
      const message = [`自动修复已停止：${result.command} 连续失败，已达到最多 ${MAX_FIX_ATTEMPTS} 次修复尝试。`, "", "最后一次失败摘要：", failureSummary].join("\n");
      setState((current) => ({
        ...current,
        autoFix: {
          command: result.command,
          attempts: MAX_FIX_ATTEMPTS,
          maxAttempts: MAX_FIX_ATTEMPTS,
          awaitingPatchId: null,
          lastFailureSummary: failureSummary
        },
        error: message,
        agentSteps: [...current.agentSteps, createClientErrorStep(message)]
      }));
      return;
    }

    setState((current) => ({
      ...current,
      loading: true,
      error: null,
      patch: null,
      autoFix: {
        command: result.command,
        attempts: nextAttempt,
        maxAttempts: MAX_FIX_ATTEMPTS,
        awaitingPatchId: null,
        lastFailureSummary: failureSummary
      },
      agentSteps: [
        ...current.agentSteps,
        {
          id: `auto-fix:${Date.now()}:${crypto.randomUUID()}`,
          type: "message",
          content: `验证失败，正在生成第 ${nextAttempt}/${MAX_FIX_ATTEMPTS} 次修复 patch：${result.command}`,
          createdAt: Date.now()
        }
      ]
    }));

    let streamTaskSessionId: string | null = null;

    try {
      const controller = new AbortController();
      streamAbortController.current = controller;

      await streamGenerateEdit(
        state.selectedPath,
        buildAutoFixPrompt(result, nextAttempt),
        (streamEvent) => {
          if (streamEvent.event === "task_session") {
            streamTaskSessionId = streamEvent.data.session.id;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.session.id,
              taskSessions: [streamEvent.data.session, ...current.taskSessions.filter((session) => session.id !== streamEvent.data.session.id)]
            }));
          }

          if (streamEvent.event === "agent_step") {
            setState((current) => ({
              ...current,
              agentSteps: [...current.agentSteps.filter((step) => step.id !== streamEvent.data.step.id), streamEvent.data.step]
            }));
          }

          if (streamEvent.event === "done") {
            streamTaskSessionId = streamEvent.data.patch.taskSessionId || streamTaskSessionId;
            setState((current) => ({
              ...current,
              currentTaskSessionId: streamEvent.data.patch.taskSessionId || current.currentTaskSessionId,
              patch: streamEvent.data.patch,
              autoFix: {
                command: result.command,
                attempts: nextAttempt,
                maxAttempts: MAX_FIX_ATTEMPTS,
                awaitingPatchId: streamEvent.data.patch.patchId,
                lastFailureSummary: failureSummary
              },
              agentSteps: streamEvent.data.patch.agentSteps || current.agentSteps
            }));
            void refreshTaskSessions(streamTaskSessionId);
          }

          if (streamEvent.event === "error") {
            throw new Error(streamEvent.data.error);
          }
        },
        controller.signal
      );
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        const message = error instanceof Error ? error.message : "生成自动修复 patch 失败";
        setState((current) => ({
          ...current,
          error: message,
          agentSteps: [...current.agentSteps, createClientErrorStep(message)]
        }));
      }
    } finally {
      streamAbortController.current = null;
      void refreshTaskSessions(streamTaskSessionId);
      setState((current) => ({ ...current, loading: false }));
    }
  }

  function commandResultForAgentStep(result: CommandResult): CommandResult {
    return {
      ...result,
      stdout: "",
      stderr: "",
      summary: result.summary ? "命令输出已发送到终端面板。" : undefined,
      outputTruncated: result.outputTruncated || Boolean(result.stdout || result.stderr || result.summary)
    };
  }

  async function handleRunCommandSuggestion(suggestion: CommandSuggestion, options?: { autoSafeOnly?: boolean }) {
    if (!state.workspaceRoot || state.loading || state.streaming) return null;

    try {
      const { policy } = await fetchCommandPolicy(suggestion.command);

      if (options?.autoSafeOnly && policy.level !== "safe") {
        return null;
      }

      setState((current) => ({ ...current, loading: true, error: null }));

      if (policy.level === "blocked") {
        setState((current) => ({
          ...current,
          loading: false,
          error: policy.reason,
          agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "blocked", policy, null)]
        }));
        return null;
      }

      let confirmed = policy.level === "safe";

      if (policy.level === "confirm") {
        confirmed = window.confirm(`该命令需要确认后执行：\n\n${suggestion.command}\n\n原因：${policy.reason}\n\n确认执行？`);
      }

      if (!confirmed) {
        setState((current) => ({
          ...current,
          loading: false,
          agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "cancelled", policy, null)]
        }));
        return null;
      }

      setState((current) => ({
        ...current,
        agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "running", policy, null)]
      }));

      setTerminalOpen(true);
      const requestId = crypto.randomUUID();
      const result = await new Promise<CommandResult | null>((resolve) => {
        terminalCommandResolvers.current[requestId] = resolve;
        terminalCommandTaskSessions.current[requestId] = state.currentTaskSessionId;
        setTerminalCommandRequest({ id: requestId, command: suggestion.command, chatId: state.chatId });
      });

      if (!result) {
        setState((current) => ({
          ...current,
          loading: false,
          agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, "failed", policy, null)]
        }));
        return null;
      }

      const status = result.status === "success" || result.status === "running" ? "success" : "failed";
      const visibleResult = commandResultForAgentStep(result);

      setState((current) => ({
        ...current,
        loading: false,
        agentSteps: [...current.agentSteps, createCommandAgentStep(suggestion.command, status, policy, visibleResult)]
      }));

      if (status === "failed") {
        await generateAutoFixPatch(result);
      } else {
        setState((current) => ({ ...current, autoFix: null }));
      }

      return visibleResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "命令执行失败";
      setState((current) => ({
        ...current,
        loading: false,
        error: message,
        agentSteps: [...current.agentSteps, createClientErrorStep(message)]
      }));
      return null;
    }
  }

  function handleTerminalCommandComplete(completion: TerminalCommandCompletion) {
    const resolve = terminalCommandResolvers.current[completion.id];

    if (resolve) {
      resolve(completion.result);
      delete terminalCommandResolvers.current[completion.id];
    }

    const taskSessionId = terminalCommandTaskSessions.current[completion.id];
    delete terminalCommandTaskSessions.current[completion.id];

    if (taskSessionId && completion.result) {
      void recordTaskSessionCommand(taskSessionId, completion.result.command, completion.result).then(() => refreshTaskSessions(taskSessionId));
    }

    if (completion.error) {
      setState((current) => ({ ...current, loading: false, error: completion.error || null }));
    }
  }
  return (
    <AppLayout
      files={files}
      state={state}
      chatWidth={chatWidth}
      terminalHeight={terminalHeight}
      terminalOpen={terminalOpen}
      terminalCommandRequest={terminalCommandRequest}
      leftPanel={leftPanel}
      savingFile={savingFile}
      setState={setState}
      setTerminalOpen={setTerminalOpen}
      setLeftPanel={setLeftPanel}
      onOpenWorkspace={handleOpenWorkspace}
      onPickWorkspace={handlePickWorkspace}
      onOpenFile={handleOpenFile}
      onSelectOpenFile={handleSelectOpenFile}
      onCloseOpenFile={handleCloseOpenFile}
      onToggleShowIgnored={handleToggleShowIgnored}
      onSaveFile={handleSaveFile}
      onStartChatResize={(event) => {
        event.preventDefault();
        resizingChat.current = true;
        document.body.classList.add("resizing-chat");
      }}
      onStartTerminalResize={(event) => {
        event.preventDefault();
        resizingTerminal.current = true;
        document.body.classList.add("resizing-terminal");
      }}
      onCloseTerminal={() => {
        resizingTerminal.current = false;
        document.body.classList.remove("resizing-terminal");
        setTerminalOpen(false);
      }}
      onTerminalCommandComplete={handleTerminalCommandComplete}
      onRollbackLastCheckpoint={handleRollbackLastCheckpoint}
      onClearChat={handleClearChat}
      onOpenChatHistory={handleOpenChatHistory}
      onRefreshChatHistories={handleRefreshChatHistories}
      onRefreshTaskSessions={handleRefreshTaskSessions}
      onRefreshProjectRules={handleRefreshProjectRules}
      onOpenTaskSession={handleOpenTaskSession}
      onAddPlanItem={handleAddPlanItem}
      onUpdatePlanItem={handleUpdatePlanItem}
      onDeletePlanItem={handleDeletePlanItem}
      onRewritePlan={handleRewritePlan}
      onApprovePlan={handleApprovePlan}
      onNewChat={handleNewChat}
      onDeleteChatHistory={handleDeleteChatHistory}
      onStopChat={handleStopChat}
      onDeleteMessage={handleDeleteChatMessage}
      onBranchMessage={handleBranchChatMessage}
      onRerunMessage={(content, messageId) => void handleSendChatMessage(content, messageId)}
      onRunCommandSuggestion={handleRunCommandSuggestion}
      onValidateAndFix={(command) => handleValidateAndFix(command)}
      onGenerate={handleGenerate}
      onApplyPatch={handleApply}
      onRejectPatch={handleReject}
      onRollbackCheckpoint={rollbackCheckpointAndRefresh}
    />
  );
}
