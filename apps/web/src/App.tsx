import { useEffect, useState } from "react";
import { createProvider, decideApprovalRequest, fetchModelCatalog, updateModelDefaults, updateProviderSettings, type AgentMode, type AgentStep, type CreateProviderInput, type FileTreeNode, type ModelSelectionDefaults, type PatchFileChange, type ProviderSettings, type ProviderSettingsInput, type UnifiedDiagnostic } from "./api";
import { writeAgentPreferences } from "./agentPreferences";
import { initialState, type AppState } from "./appState";
import AppLayout from "./components/AppLayout";
import SettingsPage, { type SettingsSection } from "./components/settings/SettingsPage";
import { useChatSession } from "./hooks/useChatSession";
import { useCommandCenter } from "./hooks/useCommandCenter";
import { usePatchActions } from "./hooks/usePatchActions";
import { useTaskSessions } from "./hooks/useTaskSessions";
import { useWorkbenchLayout } from "./hooks/useWorkbenchLayout";
import { useWorkspaceFiles } from "./hooks/useWorkspaceFiles";
import type { InlineEditUpgradeRequest } from "./hooks/useInlineEdit";

export default function App() {
  // App 只负责组合各领域 hook，避免继续堆积业务细节。
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [state, setState] = useState<AppState>(initialState);
  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [savingDefaults, setSavingDefaults] = useState(false);

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

  useEffect(() => {
    let active = true;
    fetchModelCatalog()
      .then((catalog) => active && setState((current) => ({ ...current, modelCatalog: catalog, modelDefaults: catalog.defaults, providerSettings: catalog.providerSettings })))
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handlePopState = () => setCurrentPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);


  async function handleUpdateProviderSettings(settings: ProviderSettingsInput) {
    const result = await updateProviderSettings(settings);
    setState((current) => ({
      ...current,
      providerSettings: result.providerSettings,
      modelDefaults: result.defaults,
      modelCatalog: current.modelCatalog ? {
        ...current.modelCatalog,
        providers: result.providers,
        defaults: result.defaults,
        providerSettings: result.providerSettings
      } : current.modelCatalog,
      error: null
    }));
  }

  async function handleCreateProvider(input: CreateProviderInput): Promise<ProviderSettings> {
    const result = await createProvider(input);
    setState((current) => ({
      ...current,
      providerSettings: result.providerSettings,
      modelCatalog: current.modelCatalog ? {
        ...current.modelCatalog,
        providers: result.providers,
        providerSettings: result.providerSettings
      } : current.modelCatalog
    }));
    return result.settings;
  }

  async function handleSaveAgentDefaults(defaultMode: AgentMode, defaults: ModelSelectionDefaults) {
    setSavingDefaults(true);
    try {
      const result = await updateModelDefaults(defaults);
      writeAgentPreferences({ defaultMode });
      setState((current) => ({
        ...current,
        defaultAgentMode: defaultMode,
        agentMode: current.currentTaskSessionId ? current.agentMode : defaultMode,
        modelDefaults: result.defaults,
        modelCatalog: current.modelCatalog ? { ...current.modelCatalog, defaults: result.defaults } : current.modelCatalog
      }));
    } finally {
      setSavingDefaults(false);
    }
  }

  function navigateTo(path: string) {
    window.history.pushState({}, "", path);
    setCurrentPath(path);
  }

  async function handleApprovePlan(taskSessionId: string) {
    const session = await taskSessions.handleApprovePlan(taskSessionId);

    if (!session) return;

    await chatSession.handleSendChatMessage(session.userGoal, undefined, session.id);
  }

  async function handleInterruptTaskForReplan(taskSessionId: string, instruction: string) {
    const session = await taskSessions.handleInterruptTaskPlan(taskSessionId, instruction);

    if (!session) return;

    chatSession.handleStopChat();
  }

  async function handleOpenTaskSession(taskSessionId: string) {
    const session = await taskSessions.handleOpenTaskSession(taskSessionId);

    // 打开任务历史时恢复成当前聊天会话，兼容没有 chatId 的旧任务或直接编辑任务。
    if (session) {
      await chatSession.handleOpenTaskSessionChat(session);
    }
  }

  function upsertTaskSession(session: NonNullable<AppState["selectedTaskSession"]>) {
    setState((current) => ({
      ...current,
      agentSteps: session.id === current.currentTaskSessionId || session.id === current.selectedTaskSession?.id ? session.steps : current.agentSteps,
      selectedTaskSession: current.selectedTaskSession?.id === session.id ? session : current.selectedTaskSession,
      taskSessions: [session, ...current.taskSessions.filter((item) => item.id !== session.id)].sort((left, right) => right.createdAt - left.createdAt)
    }));
  }

  async function handleApplyPatch(filePath?: string, acknowledgeSafeEditRisk = false) {
    await patchActions.handleApply(filePath, commandCenter.handleValidateAndFix, acknowledgeSafeEditRisk);
  }

  async function handleFixDiagnostic(diagnostic: UnifiedDiagnostic, codeActionTitle?: string) {
    const contextPaths = [...new Set([...state.chatContextPaths, diagnostic.filePath])];
    const prompt = [
      `请修复 ${diagnostic.filePath}:${diagnostic.range.start.line}:${diagnostic.range.start.column} 的诊断：${diagnostic.message}`,
      codeActionTitle ? `Language Server 建议操作：${codeActionTitle}` : "",
      "请分析根因，生成可审阅 Patch，并在应用后执行相关验证。"
    ].filter(Boolean).join("\n");
    setState((current) => ({ ...current, chatContextPaths: contextPaths, userRequest: "" }));
    await chatSession.handleSendChatMessage(prompt, undefined, undefined, { contextPaths });
  }

  async function handleUpgradeInlineEdit(request: InlineEditUpgradeRequest) {
    const contextPaths = [...new Set([...state.chatContextPaths, request.draft.filePath])];
    const prompt = [
      "Inline Edit 判断该需求需要跨文件修改，请升级为完整 Patch Review。",
      `目标文件：${request.draft.filePath}`,
      `原修改要求：${request.instruction}`,
      `升级原因：${request.reason}`,
      `原选区：${request.draft.selection.start.line}:${request.draft.selection.start.column}-${request.draft.selection.end.line}:${request.draft.selection.end.column}`,
      request.draft.selectedText ? `原选区内容：\n${request.draft.selectedText.slice(0, 8_000)}` : "原选区为空，请以光标位置为修改入口。",
      "请分析影响范围，生成可审阅 Patch；不得静默落盘。"
    ].join("\n\n");
    setState((current) => ({ ...current, patch: null, chatContextPaths: contextPaths, error: null }));
    await chatSession.handleSendChatMessage(prompt, undefined, undefined, { contextPaths, agentMode: "act" });
  }

  async function handleRegeneratePatchFile(file: PatchFileChange) {
    const prompt = [
      `请重新生成 Patch 中 ${file.path} 的修改。`,
      `当前修改摘要：${file.summary}`,
      "保留原任务目标，但重新分析该文件的最小必要改动；如果影响其他文件，请生成完整可审阅 Patch。",
      `当前候选内容（仅供参考）：\n${file.newContent.slice(0, 8_000)}`
    ].join("\n\n");
    setState((current) => ({ ...current, patch: null, error: null, chatContextPaths: [...new Set([...current.chatContextPaths, file.path])] }));
    await chatSession.handleSendChatMessage(prompt, undefined, undefined, { contextPaths: [file.path], agentMode: "act" });
  }

  async function handleAnalyzePatchImpact() {
    if (!state.patch) return;
    const patch = state.patch;
    const contextPaths = patch.files.map((file) => file.path);
    const prompt = [
      "当前待审核补丁缺少完整的修改范围证据。",
      `候选文件：${contextPaths.join("、")}`,
      "请先执行影响分析，核对结构化修改计划、引用关系和相关验证，再基于完整证据重新生成整个可审核补丁。",
      "不要绕过 Safe Editor，也不要直接应用任何修改。"
    ].join("\n\n");
    setState((current) => ({ ...current, patch: null, error: null, chatContextPaths: [...new Set([...current.chatContextPaths, ...contextPaths])] }));
    await chatSession.handleSendChatMessage(prompt, undefined, undefined, { contextPaths, agentMode: "act" });
  }

  async function handleRegenerateWholePatch() {
    if (!state.patch) return;
    const patch = state.patch;
    const contextPaths = patch.files.map((file) => file.path);
    const prompt = [
      "请重新生成当前整个待审核补丁。",
      `原补丁摘要：${patch.finalSummary || patch.summary}`,
      `原候选文件：${contextPaths.join("、")}`,
      "保留原任务目标，重新确认最小必要修改范围；先补齐所需证据，再返回完整的可审核 Patch。"
    ].join("\n\n");
    setState((current) => ({ ...current, patch: null, error: null, chatContextPaths: [...new Set([...current.chatContextPaths, ...contextPaths])] }));
    await chatSession.handleSendChatMessage(prompt, undefined, undefined, { contextPaths, agentMode: "act" });
  }

  async function handleApprovalDecision(step: Extract<AgentStep, { type: "approval_request" }>, decision: "approved" | "rejected") {
    const taskSessionId = state.currentTaskSessionId || state.selectedTaskSession?.id || null;

    if (!taskSessionId) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    const details = step.details && typeof step.details === "object" && !Array.isArray(step.details) ? (step.details as { approvalSource?: unknown }) : null;
    const isAgentRuntimeApproval = details?.approvalSource === "agent_runtime";

    try {
      if (!isAgentRuntimeApproval && step.actionType === "edit_files") {
        if (decision === "approved") {
          await patchActions.handleApply(undefined, commandCenter.handleValidateAndFix);
        } else {
          await patchActions.handleReject();
        }
      } else if (!isAgentRuntimeApproval && step.actionType === "run_command" && decision === "approved" && step.command) {
        await commandCenter.handleValidateAndFix(step.command);
      }

      const result = await decideApprovalRequest(taskSessionId, step.actionId, decision);
      upsertTaskSession(result.session);
      setState((current) => ({
        ...current,
        chatMessages: result.messages || current.chatMessages,
        // 审批接口返回 null 表示旧补丁已经被本次运行时操作消费，只有未返回 patch 字段时才保留当前预览。
        patch: Object.prototype.hasOwnProperty.call(result, "patch") ? result.patch ?? null : current.patch
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : "处理审批失败" }));
    } finally {
      setState((current) => ({ ...current, loading: false }));
    }
  }

  if (currentPath === "/settings" || currentPath.startsWith("/settings/")) {
    const requestedSection = currentPath.split("/")[2];
    const section: SettingsSection = requestedSection === "providers" || requestedSection === "rules" || requestedSection === "memory" ? requestedSection : "general";
    return (
      <SettingsPage
        section={section}
        defaultAgentMode={state.defaultAgentMode}
        modelDefaults={state.modelDefaults}
        providerSettings={state.providerSettings}
        catalog={state.modelCatalog}
        projectRules={state.projectRules}
        workspaceRoot={state.workspaceRoot}
        loading={state.loading}
        savingDefaults={savingDefaults}
        onBack={() => navigateTo("/")}
        onNavigate={(nextSection) => navigateTo(`/settings/${nextSection}`)}
        onSaveDefaults={handleSaveAgentDefaults}
        onSaveProvider={handleUpdateProviderSettings}
        onCreateProvider={handleCreateProvider}
        onRefreshProjectRules={workspaceFiles.handleRefreshProjectRules}
      />
    );
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
      leftPanelOpen={layout.leftPanelOpen}
      chatPanelOpen={layout.chatPanelOpen}
      focusMode={layout.focusMode}
      savingFile={workspaceFiles.savingFile}
      setState={setState}
      setTerminalOpen={layout.setTerminalOpen}
      onSelectLeftPanel={layout.handleSelectLeftPanel}
      onToggleChatPanel={layout.handleToggleChatPanel}
      onToggleFocusMode={layout.handleToggleFocusMode}
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
      onOpenTaskSession={handleOpenTaskSession}
      onDeleteTaskSession={taskSessions.handleDeleteTaskSession}
      onAddPlanItem={taskSessions.handleAddPlanItem}
      onUpdatePlanItem={taskSessions.handleUpdatePlanItem}
      onDeletePlanItem={taskSessions.handleDeletePlanItem}
      onRewritePlan={taskSessions.handleRewritePlan}
      onApprovePlan={handleApprovePlan}
      onInterruptTaskForReplan={handleInterruptTaskForReplan}
      onUpdateAgentMode={taskSessions.handleUpdateAgentMode}
      onOpenSettings={() => navigateTo("/settings/general")}
      onNewChat={chatSession.handleNewChat}
      onDeleteChatHistory={chatSession.handleDeleteChatHistory}
      onStopChat={chatSession.handleStopChat}
      onDeleteMessage={chatSession.handleDeleteChatMessage}
      onBranchMessage={chatSession.handleBranchChatMessage}
      onRerunMessage={(content, messageId) => void chatSession.handleSendChatMessage(content, messageId)}
      onRunCommandSuggestion={commandCenter.handleRunCommandSuggestion}
      onValidateAndFix={commandCenter.handleValidateAndFix}
      onGenerate={chatSession.handleGenerate}
      onFixDiagnostic={handleFixDiagnostic}
      onApplyPatch={handleApplyPatch}
      onRejectPatch={patchActions.handleReject}
      onRollbackCheckpoint={patchActions.rollbackCheckpointAndRefresh}
      onDecideApproval={handleApprovalDecision}
      onUpgradeInlineEdit={handleUpgradeInlineEdit}
      onRegeneratePatchFile={handleRegeneratePatchFile}
      onRegenerateWholePatch={handleRegenerateWholePatch}
      onAnalyzePatchImpact={handleAnalyzePatchImpact}
      onRejectExpansionFiles={patchActions.handleRejectExpansionFiles}
    />
  );
}
