import type { Dispatch, SetStateAction } from "react";
import { applyPatch, fetchCheckpoint, fetchFiles, rejectPatch, rollbackCheckpoint, type FileTreeNode } from "../api";
import type { AppState } from "../appState";

type UsePatchActionsOptions = {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  setFiles: Dispatch<SetStateAction<FileTreeNode[]>>;
  refreshTaskSessions: (selectedTaskSessionId?: string | null) => Promise<void>;
};

// 统一处理 patch 应用和 checkpoint 回滚，避免文件状态同步分散在多个地方。
export function usePatchActions({ state, setState, setFiles, refreshTaskSessions }: UsePatchActionsOptions) {
  async function handleApply(filePath: string | undefined, onValidateAndFix: (command: string) => Promise<unknown>) {
    if (!state.patch) return;

    const patchToApply = state.patch;
    const selectedPathToApply = state.selectedPath;
    const targetFiles = filePath ? patchToApply.files.filter((file) => file.path === filePath) : patchToApply.files;

    if (!targetFiles.length) return;

    setState((current) => ({ ...current, loading: true, error: null }));

    try {
      const result = await applyPatch(patchToApply.patchId, filePath);
      const nodes = targetFiles.some((file) => file.status === "create" || file.status === "delete") ? await fetchFiles("", state.showIgnoredFiles) : null;
      if (nodes) {
        setFiles(nodes);
      }
      void refreshTaskSessions(patchToApply.taskSessionId || state.currentTaskSessionId);
      const remainingFiles = filePath ? patchToApply.files.filter((file) => file.path !== filePath) : [];
      const validationCommand = !remainingFiles.length ? state.autoFix?.awaitingPatchId === patchToApply.patchId ? state.autoFix.command : patchToApply.commandsToRun?.[0] || null : null;
      setState((current) => {
        const selectedFileChange = targetFiles.find((file) => file.path === current.selectedPath);
        const fallbackSelectedChange = current.selectedPath === selectedPathToApply && !filePath ? patchToApply : null;
        const selectedFileDeleted = selectedFileChange?.status === "delete" || (fallbackSelectedChange?.files || []).some((file) => file.path === current.selectedPath && file.status === "delete");
        const nextSelectedContent = selectedFileDeleted ? "" : selectedFileChange?.newContent ?? fallbackSelectedChange?.newContent;

        return {
          ...current,
          selectedPath: selectedFileDeleted ? null : current.selectedPath,
          fileContent: nextSelectedContent ?? current.fileContent,
          savedFileContent: nextSelectedContent ?? current.savedFileContent,
          openFiles: current.openFiles
            .filter((openFile) => !targetFiles.some((file) => file.path === openFile.path && file.status === "delete"))
            .map((openFile) => {
              const appliedFile = targetFiles.find((file) => file.path === openFile.path);
              return appliedFile ? { ...openFile, content: appliedFile.newContent, savedContent: appliedFile.newContent } : openFile;
            }),
          loading: false,
          lastCheckpoint: result.checkpoint,
          dismissedCheckpointId: null,
          patch: remainingFiles.length
            ? {
                ...patchToApply,
                files: remainingFiles,
                oldContent: remainingFiles[0].oldContent,
                newContent: remainingFiles[0].newContent,
                diffHtml: remainingFiles.map((file) => '<div class="diff-file-header">' + (file.status === "delete" ? file.path + " (deleted file)" : file.status === "create" ? file.path + " (new file)" : file.path) + "</div>" + file.diffHtml).join("")
              }
            : null
        };
      });

      if (validationCommand) {
        await onValidateAndFix(validationCommand);
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
        lastCheckpoint: current.lastCheckpoint?.id === checkpoint.id ? null : current.lastCheckpoint,
        dismissedCheckpointId: current.lastCheckpoint?.id === checkpoint.id ? null : current.dismissedCheckpointId
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
      void refreshTaskSessions(patchToReject.taskSessionId || state.currentTaskSessionId);
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
              diffHtml: remainingFiles.map((file) => '<div class="diff-file-header">' + (file.status === "delete" ? file.path + " (deleted file)" : file.status === "create" ? file.path + " (new file)" : file.path) + "</div>" + file.diffHtml).join("")
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

  return {
    handleApply,
    rollbackCheckpointAndRefresh,
    handleRollbackLastCheckpoint,
    handleReject
  };
}
