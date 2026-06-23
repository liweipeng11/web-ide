import type { Dispatch, PointerEvent, SetStateAction } from "react";
import type { CommandResult, FileTreeNode, TaskPlanItemStatus } from "../api";
import type { AppState, CommandSuggestion } from "../appState";
import { collectFilePaths } from "../appState";
import GitWorkflowPanel from "../gitWorkflow/GitWorkflowPanel";
import ChatPanel from "./ChatPanel";
import CodeSearchPanel from "./CodeSearchPanel";
import DiffViewer from "./DiffViewer";
import EditorPane from "./EditorPane";
import FileTree from "./FileTree";
import Icon from "./Icon";
import ProjectRulesPanel from "./ProjectRulesPanel";
import TerminalPanel, { type TerminalCommandCompletion, type TerminalCommandRequest } from "./TerminalPanel";

type Props = {
  files: FileTreeNode[];
  state: AppState;
  chatWidth: number;
  terminalHeight: number;
  terminalOpen: boolean;
  terminalCommandRequest: TerminalCommandRequest | null;
  leftPanel: "files" | "search" | "rules" | "git";
  savingFile: boolean;
  setState: Dispatch<SetStateAction<AppState>>;
  setTerminalOpen: Dispatch<SetStateAction<boolean>>;
  setLeftPanel: Dispatch<SetStateAction<"files" | "search" | "rules" | "git">>;
  onOpenWorkspace: () => void;
  onPickWorkspace: () => void;
  onOpenFile: (path: string) => Promise<void>;
  onSelectOpenFile: (path: string) => void;
  onCloseOpenFile: (path: string) => void;
  onToggleShowIgnored: (showIgnored: boolean) => Promise<void>;
  onSaveFile: () => Promise<void>;
  onStartChatResize: (event: PointerEvent) => void;
  onStartTerminalResize: (event: PointerEvent) => void;
  onCloseTerminal: () => void;
  onTerminalCommandComplete: (completion: TerminalCommandCompletion) => void;
  onRollbackLastCheckpoint: () => Promise<void>;
  onClearChat: () => Promise<void>;
  onOpenChatHistory: (path: string) => Promise<void>;
  onRefreshChatHistories: () => Promise<void>;
  onRefreshTaskSessions: () => Promise<void>;
  onRefreshProjectRules: () => Promise<void>;
  onOpenTaskSession: (taskSessionId: string) => Promise<void>;
  onDeleteTaskSession: (taskSessionId: string) => Promise<void>;
  onAddPlanItem: (taskSessionId: string, title: string) => Promise<void>;
  onUpdatePlanItem: (taskSessionId: string, planItemId: string, updates: { title?: string; status?: TaskPlanItemStatus; note?: string }) => Promise<void>;
  onDeletePlanItem: (taskSessionId: string, planItemId: string) => Promise<void>;
  onRewritePlan: (taskSessionId: string, instruction: string) => Promise<void>;
  onApprovePlan: (taskSessionId: string) => Promise<void>;
  onNewChat: () => void;
  onDeleteChatHistory: (path: string) => Promise<void>;
  onStopChat: () => void;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onBranchMessage: (messageId: string) => Promise<void>;
  onRerunMessage: (content: string, messageId: string) => void;
  onRunCommandSuggestion: (suggestion: CommandSuggestion, options?: { autoSafeOnly?: boolean }) => Promise<CommandResult | null>;
  onValidateAndFix: (command: string) => Promise<unknown>;
  onGenerate: () => Promise<void>;
  onApplyPatch: (filePath?: string) => Promise<void>;
  onRejectPatch: (filePath?: string) => Promise<void>;
  onRollbackCheckpoint: (checkpointId: string) => Promise<void>;
};

export default function AppLayout({
  files,
  state,
  chatWidth,
  terminalHeight,
  terminalOpen,
  terminalCommandRequest,
  leftPanel,
  savingFile,
  setState,
  setTerminalOpen,
  setLeftPanel,
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
  onRefreshProjectRules,
  onOpenTaskSession,
  onDeleteTaskSession,
  onAddPlanItem,
  onUpdatePlanItem,
  onDeletePlanItem,
  onRewritePlan,
  onApprovePlan,
  onNewChat,
  onDeleteChatHistory,
  onStopChat,
  onDeleteMessage,
  onBranchMessage,
  onRerunMessage,
  onRunCommandSuggestion,
  onValidateAndFix,
  onGenerate,
  onApplyPatch,
  onRejectPatch,
  onRollbackCheckpoint
}: Props) {
  // 优先展示当前正在运行的任务计划，历史任务详情仍在展开面板里维护。
  const activeTaskSession = state.taskSessions.find((session) => session.id === state.currentTaskSessionId) || state.selectedTaskSession || null;
  const visibleCheckpoint = state.lastCheckpoint && state.lastCheckpoint.id !== state.dismissedCheckpointId ? state.lastCheckpoint : null;

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
            void onOpenWorkspace();
          }}
        >
          <input
            value={state.workspaceInput}
            disabled={state.loading}
            placeholder="项目文件夹绝对路径"
            onChange={(event) => setState((current) => ({ ...current, workspaceInput: event.target.value }))}
          />
          <button type="button" className="icon-button" disabled={state.loading} title="选择项目" aria-label="选择项目" onClick={() => void onPickWorkspace()}>
            <Icon name="folder-open" />
          </button>
        </form>
        <button type="button" className="terminal-toggle icon-button" title="切换终端 (Ctrl+`)" aria-label="切换终端" onClick={() => setTerminalOpen((current) => !current)}>
          <Icon name="terminal" />
        </button>
        {state.loading && <strong>处理中...</strong>}
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
        <section className="workspace-layout" style={{ gridTemplateColumns: `48px minmax(220px, 260px) minmax(360px, 1fr) ${chatWidth}px` }}>
          <nav className="activity-bar" aria-label="Primary">
            <button type="button" className={leftPanel === "files" ? "active" : ""} title="文件树" aria-label="文件树" aria-pressed={leftPanel === "files"} onClick={() => setLeftPanel("files")}>
              <Icon name="folder-open" />
            </button>
            <button type="button" className={leftPanel === "rules" ? "active" : ""} title="Project Rules" aria-label="Project Rules" aria-pressed={leftPanel === "rules"} onClick={() => setLeftPanel("rules")}>
              <Icon name="rules" />
            </button>
            <button type="button" className={leftPanel === "search" ? "active" : ""} title="代码搜索 (Ctrl+Shift+F)" aria-label="代码搜索" aria-pressed={leftPanel === "search"} onClick={() => setLeftPanel("search")}>
              <Icon name="search" />
            </button>
            <button type="button" className={leftPanel === "git" ? "active" : ""} title="Git 工作流" aria-label="Git 工作流" aria-pressed={leftPanel === "git"} onClick={() => setLeftPanel("git")}>
              <Icon name="branch" />
            </button>
          </nav>

          <aside className="left-sidebar">
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
            ) : leftPanel === "rules" ? (
              <ProjectRulesPanel disabled={!state.workspaceRoot} rules={state.projectRules} onRefresh={() => void onRefreshProjectRules()} />
            ) : (
              <GitWorkflowPanel
                disabled={!state.workspaceRoot}
                taskSessionId={state.currentTaskSessionId || state.selectedTaskSession?.id || null}
                taskSessions={state.taskSessions}
                onRefreshTaskSessions={onRefreshTaskSessions}
              />
            )}
          </aside>

          <div className="editor-column">
            <EditorPane
              path={state.selectedPath}
              tabs={state.openFiles}
              value={state.fileContent}
              dirty={state.fileContent !== state.savedFileContent}
              saving={savingFile}
              onSave={() => void onSaveFile()}
              onSelectTab={onSelectOpenFile}
              onCloseTab={onCloseOpenFile}
              onChange={(fileContent) =>
                setState((current) => ({
                  ...current,
                  fileContent,
                  openFiles: current.openFiles.map((file) => (file.path === current.selectedPath ? { ...file, content: fileContent } : file))
                }))
              }
            />
            {terminalOpen && (
              <TerminalPanel
                workspaceRoot={state.workspaceRoot}
                height={terminalHeight}
                commandRequest={terminalCommandRequest}
                onCommandComplete={onTerminalCommandComplete}
                onClose={onCloseTerminal}
                onStartResize={onStartTerminalResize}
              />
            )}
          </div>

          <div className="chat-column">
            <div className="chat-resizer" role="separator" aria-orientation="vertical" title="调整智能体面板宽度" onPointerDown={onStartChatResize} />
            <ChatPanel
              value={state.userRequest}
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
            />
          </div>
        </section>
      </section>

      <DiffViewer patch={state.patch} loading={state.loading} autoFix={state.autoFix} onApply={onApplyPatch} onReject={onRejectPatch} onRunCommand={(command) => void onValidateAndFix(command)} />
    </main>
  );
}
