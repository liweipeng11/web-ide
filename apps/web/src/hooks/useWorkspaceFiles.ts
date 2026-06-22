import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { fetchFile, fetchFiles, fetchFileChatHistories, fetchProjectRules, fetchTaskSessions, fetchWorkspace, openWorkspace, pickWorkspace, saveFile, type FileTreeNode } from "../api";
import { createChatId, type AppState } from "../appState";

type UseWorkspaceFilesOptions = {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  setFiles: Dispatch<SetStateAction<FileTreeNode[]>>;
};

// 负责工作区与文件编辑相关操作，让 App.tsx 只保留编排职责。
export function useWorkspaceFiles({ state, setState, setFiles }: UseWorkspaceFilesOptions) {
  const [savingFile, setSavingFile] = useState(false);

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
  }, [setFiles, setState]);

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
        dismissedCheckpointId: null,
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
        dismissedCheckpointId: null,
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

  return {
    savingFile,
    handleOpenWorkspace,
    handlePickWorkspace,
    handleOpenFile,
    handleRefreshProjectRules,
    handleToggleShowIgnored,
    handleSaveFile,
    handleSelectOpenFile,
    handleCloseOpenFile
  };
}
