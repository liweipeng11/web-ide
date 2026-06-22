import { useRef, type Dispatch, type SetStateAction } from "react";
import { branchFileChatMessage, clearFileChat, deleteFileChatHistory, deleteFileChatMessage, fetchFileChat, fetchFileChatHistories, streamFileChatMessage } from "../api";
import { createChatId, createClientErrorStep, type AppState } from "../appState";

type UseChatSessionOptions = {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  refreshTaskSessions: (selectedTaskSessionId?: string | null) => Promise<void>;
};

// 负责聊天流、历史记录和消息操作，保持入口组件聚焦在视图编排。
export function useChatSession({ state, setState, refreshTaskSessions }: UseChatSessionOptions) {
  const streamAbortController = useRef<AbortController | null>(null);
  const pendingChatDeltas = useRef<Record<string, string>>({});
  const pendingChatDeltaTimer = useRef<number | null>(null);

  async function handleRefreshChatHistories() {
    if (!state.workspaceRoot) return;

    try {
      const data = await fetchFileChatHistories();
      setState((current) => ({ ...current, chatHistories: data.histories }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "加载聊天历史失败" }));
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

    // 用微小批量合并 delta，减少流式输出时的高频重渲染。
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
        const message = error instanceof Error ? error.message : "AI 请求失败";
        setState((current) => ({
          ...current,
          error: message,
          agentSteps: [...current.agentSteps, createClientErrorStep(message)]
        }));
      }
    } finally {
      if (pendingChatDeltaTimer.current !== null) {
        window.clearTimeout(pendingChatDeltaTimer.current);
        pendingChatDeltaTimer.current = null;
      }
      flushPendingChatDeltas();
      streamAbortController.current = null;
      void refreshTaskSessions(streamTaskSessionId);
      setState((current) => ({ ...current, loading: false, streaming: false }));
    }
  }

  function handleStopChat() {
    streamAbortController.current?.abort();
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

  return {
    handleRefreshChatHistories,
    handleOpenChatHistory,
    handleNewChat,
    handleDeleteChatHistory,
    handleGenerate,
    handleSendChatMessage,
    handleStopChat,
    handleClearChat,
    handleDeleteChatMessage,
    handleBranchChatMessage
  };
}
