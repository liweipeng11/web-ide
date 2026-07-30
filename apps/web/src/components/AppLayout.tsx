import { lazy, Suspense, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import type { AgentMode, AgentStep, CommandResult, FileTreeNode, PatchFileChange, SourceLocation, TaskPlanItemStatus, UnifiedDiagnostic, VerificationIssueCategory } from "../api";
import type { AppState, CommandSuggestion } from "../appState";
import { collectFilePaths } from "../appState";
import type { WorkbenchLeftPanel } from "../hooks/useWorkbenchLayout";
import type { InlineEditChangeContext, InlineEditUpgradeRequest } from "../hooks/useInlineEdit";
import ChatPanel from "./ChatPanel";
import FileTree from "./FileTree";
import Icon from "./Icon";
import type { TerminalCommandCompletion, TerminalCommandRequest } from "./TerminalPanel";

const CodeSearchPanel = lazy(() => import("./CodeSearchPanel"));
const EditorPane = lazy(() => import("./EditorPane"));
const GitWorkflowPanel = lazy(() => import("../gitWorkflow/GitWorkflowPanel"));
const PatchReviewPane = lazy(() => import("./PatchReviewPane"));
const TerminalPanel = lazy(() => import("./TerminalPanel"));

function PanelLoading({ label, fill = false }: { label: string; fill?: boolean }) {
  return (
    <div className={fill ? "panel-loading fill" : "panel-loading"} role="status">
      <span className="panel-loading-spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

type Props = {
  files: FileTreeNode[];
  state: AppState;
  chatWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
  terminalCommandRequest: TerminalCommandRequest | null;
  leftPanel: WorkbenchLeftPanel;
  leftPanelOpen: boolean;
  chatPanelOpen: boolean;
  focusMode: boolean;
  savingFile: boolean;
  setState: Dispatch<SetStateAction<AppState>>;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  onSelectLeftPanel: (panel: WorkbenchLeftPanel) => void;
  onToggleChatPanel: () => void;
  onToggleFocusMode: () => void;
  onOpenWorkspace: () => void;
  onPickWorkspace: () => void;
  onOpenFile: (path: string) => Promise<void>;
  onSelectOpenFile: (path: string) => void;
  onCloseOpenFile: (path: string) => void;
  onToggleShowIgnored: (showIgnored: boolean) => Promise<void>;
  onSaveFile: (contentOverride?: string) => Promise<boolean>;
  onStartChatResize: (event: PointerEvent) => void;
  onStartTerminalResize: (event: PointerEvent) => void;
  onCloseTerminal: () => void;
  onTerminalCommandComplete: (completion: TerminalCommandCompletion) => void;
  onRollbackLastCheckpoint: () => Promise<void>;
  onClearChat: () => Promise<void>;
  onOpenChatHistory: (path: string) => Promise<void>;
  onRefreshChatHistories: () => Promise<void>;
  onRefreshTaskSessions: () => Promise<void>;
  onOpenTaskSession: (taskSessionId: string) => Promise<void>;
  onDeleteTaskSession: (taskSessionId: string) => Promise<void>;
  onAddPlanItem: (taskSessionId: string, title: string) => Promise<void>;
  onUpdatePlanItem: (taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) => Promise<void>;
  onDeletePlanItem: (taskSessionId: string, planItemId: string) => Promise<void>;
  onRewritePlan: (taskSessionId: string, instruction: string) => Promise<void>;
  onApprovePlan: (taskSessionId: string) => Promise<void>;
  onInterruptTaskForReplan: (taskSessionId: string, instruction: string) => Promise<void>;
  onUpdateAgentMode: (taskSessionId: string | null, mode: AgentMode) => Promise<void>;
  onOpenSettings: () => void;
  onNewChat: () => void;
  onDeleteChatHistory: (path: string) => Promise<void>;
  onStopChat: () => void;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onBranchMessage: (messageId: string) => Promise<void>;
  onRerunMessage: (content: string, messageId: string) => void;
  onRunCommandSuggestion: (suggestion: CommandSuggestion, options?: { autoSafeOnly?: boolean }) => Promise<CommandResult | null>;
  onValidateAndFix: (command: string, options?: { changedFiles?: string[]; failureCategories?: VerificationIssueCategory[]; changeContext?: string }) => Promise<unknown>;
  onGenerate: () => Promise<void>;
  onFixDiagnostic: (diagnostic: UnifiedDiagnostic, codeActionTitle?: string) => Promise<void>;
  onApplyPatch: (filePath?: string, acknowledgeSafeEditRisk?: boolean) => Promise<void>;
  onRejectPatch: (filePath?: string) => Promise<void>;
  onRollbackCheckpoint: (checkpointId: string) => Promise<void>;
  onDecideApproval: (step: Extract<AgentStep, { type: "approval_request" }>, decision: "approved" | "rejected") => Promise<void>;
  onUpgradeInlineEdit: (request: InlineEditUpgradeRequest) => Promise<void>;
  onRegeneratePatchFile: (file: PatchFileChange) => Promise<void>;
  onRegenerateWholePatch: () => Promise<void>;
  onAnalyzePatchImpact: () => Promise<void>;
  onRejectExpansionFiles: (filePaths: string[]) => Promise<void>;
};

export default function AppLayout({
  files,
  state,
  chatWidth,
  terminalHeight,
  terminalOpen,
  terminalCommandRequest,
  leftPanel,
  leftPanelOpen,
  chatPanelOpen,
  focusMode,
  savingFile,
  setState,
  setTerminalOpen,
  onSelectLeftPanel,
  onToggleChatPanel,
  onToggleFocusMode,
  onOpenWorkspace,
  onPickWorkspace,
  onOpenFile,
  onSelectOpenFile,
  onCloseOpenFile,
  onToggleShowIgnored,
  onSaveFile,
  onStartChatResize,
  onStartTerminalResize,
  onCloseTerminal,
  onTerminalCommandComplete,
  onRollbackLastCheckpoint,
  onClearChat,
  onOpenChatHistory,
  onRefreshChatHistories,
  onRefreshTaskSessions,
  onOpenTaskSession,
  onDeleteTaskSession,
  onAddPlanItem,
  onUpdatePlanItem,
  onDeletePlanItem,
  onRewritePlan,
  onApprovePlan,
  onInterruptTaskForReplan,
  onUpdateAgentMode,
  onOpenSettings,
  onNewChat,
  onDeleteChatHistory,
  onStopChat,
  onDeleteMessage,
  onBranchMessage,
  onRerunMessage,
  onRunCommandSuggestion,
  onValidateAndFix,
  onGenerate,
  onFixDiagnostic,
  onApplyPatch,
  onRejectPatch,
  onRollbackCheckpoint,
  onDecideApproval,
  onUpgradeInlineEdit,
  onRegeneratePatchFile,
  onRegenerateWholePatch,
  onAnalyzePatchImpact,
  onRejectExpansionFiles
}: Props) {
  // 优先展示当前正在运行的任务计划，历史任务详情仍在展开面板里维护。
  const activeTaskSession = state.taskSessions.find((session) => session.id === state.currentTaskSessionId) || state.selectedTaskSession || null;
  const visibleCheckpoint = state.lastCheckpoint && state.lastCheckpoint.id !== state.dismissedCheckpointId ? state.lastCheckpoint : null;
  const leftPanelVisible = leftPanelOpen && !focusMode;
  const chatPanelVisible = chatPanelOpen && !focusMode;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="app-header-brand">
          <h1>Mini AI Web Editor</h1>
        </div>
        <form
          className="workspace-picker"
          onSubmit={(event) => {
            event.preventDefault();
            void onOpenWorkspace();
          }}
        >
          <input
            value={state.workspaceInput}
            disabled={state.loading}
            placeholder="项目文件夹绝对路径"
            aria-label="项目文件夹路径"
            title={state.workspaceRoot || "输入项目文件夹绝对路径"}
            onChange={(event) => setState((current) => ({ ...current, workspaceInput: event.target.value }))}
          />
          <button type="button" className="icon-button" disabled={state.loading} title="选择项目" aria-label="选择项目" onClick={() => void onPickWorkspace()}>
            <Icon name="folder-open" />
          </button>
        </form>
        <button type="button" className="terminal-toggle icon-button" title="切换终端 (Ctrl+`)" aria-label="切换终端" onClick={() => setTerminalOpen((current) => !current)}>
          <Icon name="terminal" />
        </button>
        <button type="button" className={chatPanelVisible ? "icon-button active" : "icon-button"} title="切换智能体面板" aria-label="切换智能体面板" aria-pressed={chatPanelVisible} onClick={onToggleChatPanel}>
          <Icon name="panel-right" />
        </button>
        <button type="button" className={focusMode ? "icon-button active" : "icon-button"} title="切换编辑器专注模式" aria-label="切换编辑器专注模式" aria-pressed={focusMode} onClick={onToggleFocusMode}>
          <Icon name="focus" />
        </button>
        {state.loading && <strong className="app-header-status">处理中...</strong>}
      </header>

      {state.error && <div className="error-banner">{state.error}</div>}

      {visibleCheckpoint && (
        <div className="checkpoint-banner">
          <div className="checkpoint-banner-content">
            <strong>智能体修改已应用</strong>
            <span>{visibleCheckpoint.files.length} 个文件可恢复到修改前状态</span>
          </div>
          <div className="checkpoint-banner-actions">
            <button type="button" disabled={state.loading} onClick={() => void onRollbackLastCheckpoint()}>
              撤销本次修改
            </button>
            <button
              type="button"
              className="icon-button checkpoint-banner-close"
              title="关闭提示"
              aria-label="关闭提示"
              onClick={() => {
                // 只隐藏当前提示，不清空 checkpoint，方便后续需要时继续撤销。
                setState((current) => ({
                  ...current,
                  dismissedCheckpointId: current.lastCheckpoint?.id || current.dismissedCheckpointId
                }));
              }}
            >
              <Icon name="close" />
            </button>
          </div>
        </div>
      )}

      <section className="workbench">
        <section
          className={`workspace-layout${leftPanelVisible ? "" : " left-panel-collapsed"}${chatPanelVisible ? "" : " chat-panel-collapsed"}${focusMode ? " focus-mode" : ""}`}
          style={{ gridTemplateColumns: `48px ${leftPanelVisible ? "minmax(220px, 260px)" : "0px"} minmax(360px, 1fr) ${chatPanelVisible ? `${chatWidth}px` : "0px"}` }}
        >
          <button
            type="button"
            className="workspace-drawer-backdrop"
            aria-label="关闭辅助面板"
            onClick={() => {
              if (leftPanelVisible) onSelectLeftPanel(leftPanel);
              if (chatPanelVisible) onToggleChatPanel();
            }}
          />
          <nav className="activity-bar" aria-label="Primary">
            <button type="button" className={leftPanelVisible && leftPanel === "files" ? "active" : ""} title="文件树" aria-label="文件树" aria-pressed={leftPanelVisible && leftPanel === "files"} onClick={() => onSelectLeftPanel("files")}>
              <Icon name="folder-open" />
            </button>
            <button type="button" className={leftPanelVisible && leftPanel === "search" ? "active" : ""} title="代码搜索 (Ctrl+Shift+F)" aria-label="代码搜索" aria-pressed={leftPanelVisible && leftPanel === "search"} onClick={() => onSelectLeftPanel("search")}>
              <Icon name="search" />
            </button>
            <button type="button" className={leftPanelVisible && leftPanel === "git" ? "active" : ""} title="Git 工作流" aria-label="Git 工作流" aria-pressed={leftPanelVisible && leftPanel === "git"} onClick={() => onSelectLeftPanel("git")}>
              <Icon name="branch" />
            </button>
          </nav>

          <aside className="left-sidebar" aria-hidden={!leftPanelVisible}>
            <Suspense fallback={<PanelLoading label="正在加载面板..." fill />}>
              {leftPanel === "files" ? (
                <FileTree
                  nodes={files}
                  selectedPath={state.selectedPath}
                  showIgnored={state.showIgnoredFiles}
                  onOpenFile={onOpenFile}
                  onToggleShowIgnored={(showIgnored) => void onToggleShowIgnored(showIgnored)}
                />
              ) : leftPanel === "search" ? (
                <CodeSearchPanel disabled={!state.workspaceRoot} onOpenFile={onOpenFile} />
              ) : (
                <GitWorkflowPanel
                  disabled={!state.workspaceRoot}
                  taskSessionId={state.currentTaskSessionId || state.selectedTaskSession?.id || null}
                  taskSessions={state.taskSessions}
                  onRefreshTaskSessions={onRefreshTaskSessions}
                />
              )}
            </Suspense>
          </aside>

          <div className={terminalOpen ? "editor-column terminal-open" : "editor-column"}>
            <Suspense fallback={<PanelLoading label="正在加载编辑器..." fill />}>
              {state.patch ? (
                <PatchReviewPane
                  patch={state.patch}
                  loading={state.loading}
                  autoFix={state.autoFix}
                  onApply={onApplyPatch}
                  onReject={onRejectPatch}
                  onRunCommand={(command) => void onValidateAndFix(command)}
                  onRegenerateFile={(file) => void onRegeneratePatchFile(file)}
                  onRegeneratePatch={() => void onRegenerateWholePatch()}
                  onAnalyzeImpact={() => void onAnalyzePatchImpact()}
                  onRejectExpansionFiles={(filePaths) => void onRejectExpansionFiles(filePaths)}
                />
              ) : (
                <EditorPane
                path={state.selectedPath}
                tabs={state.openFiles}
                value={state.fileContent}
                dirty={state.fileContent !== state.savedFileContent}
                saving={savingFile}
                onSave={() => void onSaveFile()}
                onSelectTab={onSelectOpenFile}
                onCloseTab={onCloseOpenFile}
                onNavigate={async (location: SourceLocation) => { await onOpenFile(location.filePath); }}
                onRequestAgentFix={(diagnostic: UnifiedDiagnostic, codeActionTitle?: string) => void onFixDiagnostic(diagnostic, codeActionTitle)}
                onPendingPatch={(patch) => setState((current) => ({ ...current, patch, error: null }))}
                onLanguageServiceError={(message) => setState((current) => ({ ...current, error: message }))}
                projectRules={state.projectRules?.combinedInstructions}
                onAcceptAndValidate={async (content, context: InlineEditChangeContext) => {
                  const changeContext = [
                    `Inline Edit 文件：${context.draft.filePath}`,
                    `修改要求：${context.instruction}`,
                    `选区：${context.draft.selection.start.line}:${context.draft.selection.start.column}-${context.draft.selection.end.line}:${context.draft.selection.end.column}`,
                    context.draft.selectedText ? `修改前选区内容：\n${context.draft.selectedText.slice(0, 4_000)}` : "修改前为空选区"
                  ].join("\n\n");
                  if (await onSaveFile(content)) await onValidateAndFix("", { changedFiles: [context.draft.filePath], changeContext });
                }}
                onUpgradeInlineEdit={onUpgradeInlineEdit}
                onChange={(fileContent) =>
                  setState((current) => ({
                    ...current,
                    fileContent,
                    openFiles: current.openFiles.map((file) => (file.path === current.selectedPath ? { ...file, content: fileContent } : file))
                  }))
                }
                />
              )}
            </Suspense>
            {terminalOpen && (
              <Suspense fallback={<PanelLoading label="正在加载终端..." />}>
                <TerminalPanel
                  workspaceRoot={state.workspaceRoot}
                  height={terminalHeight}
                  commandRequest={terminalCommandRequest}
                  onCommandComplete={onTerminalCommandComplete}
                  onClose={onCloseTerminal}
                  onStartResize={onStartTerminalResize}
                />
              </Suspense>
            )}
          </div>

          <div className="chat-column" aria-hidden={!chatPanelVisible}>
            <div className="chat-resizer" role="separator" aria-orientation="vertical" title="调整智能体面板宽度" onPointerDown={onStartChatResize} />
            <ChatPanel
              value={state.userRequest}
              agentMode={state.agentMode}
              modelCatalog={state.modelCatalog}
              modelDefaults={state.modelDefaults}
              taskModelOverride={state.taskModelOverride}
              chatId={state.chatId}
              messages={state.chatMessages}
              agentSteps={state.agentSteps}
              histories={state.chatHistories}
              taskSessions={state.taskSessions}
              activeTaskSession={activeTaskSession}
              selectedTaskSession={state.selectedTaskSession}
              availableFiles={collectFilePaths(files)}
              contextPaths={state.chatContextPaths}
              loading={state.loading}
              streaming={state.streaming}
              disabled={!state.workspaceRoot}
              onChange={(userRequest) => setState((current) => ({ ...current, userRequest }))}
              onClearChat={onClearChat}
              onOpenHistory={(path) => void onOpenChatHistory(path)}
              onRefreshHistories={() => void onRefreshChatHistories()}
              onRefreshTaskSessions={() => void onRefreshTaskSessions()}
              onOpenTaskSession={(taskSessionId) => void onOpenTaskSession(taskSessionId)}
              onDeleteTaskSession={(taskSessionId) => void onDeleteTaskSession(taskSessionId)}
              onAddPlanItem={onAddPlanItem}
              onUpdatePlanItem={onUpdatePlanItem}
              onDeletePlanItem={onDeletePlanItem}
              onRewritePlan={onRewritePlan}
              onApprovePlan={onApprovePlan}
              onInterruptTaskForReplan={onInterruptTaskForReplan}
              onUpdateAgentMode={onUpdateAgentMode}
              onOpenSettings={onOpenSettings}
              onRollbackCheckpoint={(checkpointId) => void onRollbackCheckpoint(checkpointId)}
              onNewChat={onNewChat}
              onDeleteHistory={(path) => void onDeleteChatHistory(path)}
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
              onStopChat={onStopChat}
              onDeleteMessage={onDeleteMessage}
              onBranchMessage={onBranchMessage}
              onRunCommandSuggestion={(suggestion, _message, options) => onRunCommandSuggestion(suggestion, options)}
              onRerunMessage={(message) => {
                setState((current) => ({ ...current, userRequest: message.content }));
                onRerunMessage(message.content, message.id);
              }}
              onGenerate={onGenerate}
              onDecideApproval={onDecideApproval}
            />
          </div>
        </section>
      </section>
    </main>
  );
}
