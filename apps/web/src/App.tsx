import { useState } from "react";
import { type FileTreeNode } from "./api";
import { initialState, type AppState } from "./appState";
import AppLayout from "./components/AppLayout";
import { useChatSession } from "./hooks/useChatSession";
import { useCommandCenter } from "./hooks/useCommandCenter";
import { usePatchActions } from "./hooks/usePatchActions";
import { useTaskSessions } from "./hooks/useTaskSessions";
import { useWorkbenchLayout } from "./hooks/useWorkbenchLayout";
import { useWorkspaceFiles } from "./hooks/useWorkspaceFiles";

export default function App() {
  // App 只负责组合各领域 hook，避免继续堆积业务细节。
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [state, setState] = useState<AppState>(initialState);

  const workspaceFiles = useWorkspaceFiles({ state, setState, setFiles });
  const layout = useWorkbenchLayout({ onSaveFile: workspaceFiles.handleSaveFile });
  const taskSessions = useTaskSessions({ state, setState });
  const chatSession = useChatSession({ state, setState, refreshTaskSessions: taskSessions.refreshTaskSessions });
  const commandCenter = useCommandCenter({
    state,
    setState,
    setTerminalOpen: layout.setTerminalOpen,
    refreshTaskSessions: taskSessions.refreshTaskSessions
  });
  const patchActions = usePatchActions({
    state,
    setState,
    setFiles,
    refreshTaskSessions: taskSessions.refreshTaskSessions
  });

  async function handleApprovePlan(taskSessionId: string) {
    const session = await taskSessions.handleApprovePlan(taskSessionId);

    if (!session) return;

    await chatSession.handleSendChatMessage(session.userGoal, undefined, session.id);
  }

  async function handleOpenTaskSession(taskSessionId: string) {
    const session = await taskSessions.handleOpenTaskSession(taskSessionId);

    // 打开任务历史时恢复成当前聊天会话，兼容没有 chatId 的旧任务或直接编辑任务。
    if (session) {
      await chatSession.handleOpenTaskSessionChat(session);
    }
  }

  async function handleApplyPatch(filePath?: string) {
    await patchActions.handleApply(filePath, commandCenter.handleValidateAndFix);
  }

  return (
    <AppLayout
      files={files}
      state={state}
      chatWidth={layout.chatWidth}
      terminalHeight={layout.terminalHeight}
      terminalOpen={layout.terminalOpen}
      terminalCommandRequest={commandCenter.terminalCommandRequest}
      leftPanel={layout.leftPanel}
      savingFile={workspaceFiles.savingFile}
      setState={setState}
      setTerminalOpen={layout.setTerminalOpen}
      setLeftPanel={layout.setLeftPanel}
      onOpenWorkspace={workspaceFiles.handleOpenWorkspace}
      onPickWorkspace={workspaceFiles.handlePickWorkspace}
      onOpenFile={workspaceFiles.handleOpenFile}
      onSelectOpenFile={workspaceFiles.handleSelectOpenFile}
      onCloseOpenFile={workspaceFiles.handleCloseOpenFile}
      onToggleShowIgnored={workspaceFiles.handleToggleShowIgnored}
      onSaveFile={workspaceFiles.handleSaveFile}
      onStartChatResize={layout.handleStartChatResize}
      onStartTerminalResize={layout.handleStartTerminalResize}
      onCloseTerminal={layout.handleCloseTerminal}
      onTerminalCommandComplete={commandCenter.handleTerminalCommandComplete}
      onRollbackLastCheckpoint={patchActions.handleRollbackLastCheckpoint}
      onClearChat={chatSession.handleClearChat}
      onOpenChatHistory={chatSession.handleOpenChatHistory}
      onRefreshChatHistories={chatSession.handleRefreshChatHistories}
      onRefreshTaskSessions={taskSessions.handleRefreshTaskSessions}
      onRefreshProjectRules={workspaceFiles.handleRefreshProjectRules}
      onOpenTaskSession={handleOpenTaskSession}
      onDeleteTaskSession={taskSessions.handleDeleteTaskSession}
      onAddPlanItem={taskSessions.handleAddPlanItem}
      onUpdatePlanItem={taskSessions.handleUpdatePlanItem}
      onDeletePlanItem={taskSessions.handleDeletePlanItem}
      onRewritePlan={taskSessions.handleRewritePlan}
      onApprovePlan={handleApprovePlan}
      onNewChat={chatSession.handleNewChat}
      onDeleteChatHistory={chatSession.handleDeleteChatHistory}
      onStopChat={chatSession.handleStopChat}
      onDeleteMessage={chatSession.handleDeleteChatMessage}
      onBranchMessage={chatSession.handleBranchChatMessage}
      onRerunMessage={(content, messageId) => void chatSession.handleSendChatMessage(content, messageId)}
      onRunCommandSuggestion={commandCenter.handleRunCommandSuggestion}
      onValidateAndFix={commandCenter.handleValidateAndFix}
      onGenerate={chatSession.handleGenerate}
      onApplyPatch={handleApplyPatch}
      onRejectPatch={patchActions.handleReject}
      onRollbackCheckpoint={patchActions.rollbackCheckpointAndRefresh}
    />
  );
}
