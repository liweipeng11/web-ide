import { useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { GenerateEditResponse, PatchFileChange, SafeEditFileRole } from "../api";
import type { AutoFixState } from "../appState";
import Icon from "./Icon";
import SafeEditApprovalDialog from "./SafeEditApprovalDialog";
import { createSafeEditViewModel } from "./safeEditViewModel";

type Props = {
  patch: GenerateEditResponse;
  loading: boolean;
  autoFix: AutoFixState | null;
  onApply: (filePath?: string, acknowledgeSafeEditRisk?: boolean) => void;
  onReject: (filePath?: string) => void;
  onRunCommand: (command: string) => void;
  onRegenerateFile: (file: PatchFileChange) => void;
  onRegeneratePatch: () => void;
  onAnalyzeImpact: () => void;
  onRejectExpansionFiles: (filePaths: string[]) => void;
};

function getLanguage(path: string) {
  if (path.endsWith(".ts") || path.endsWith(".tsx")) return "typescript";
  if (path.endsWith(".js") || path.endsWith(".jsx")) return "javascript";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".vue") || path.endsWith(".html")) return "html";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function getPatchFileLabel(file: PatchFileChange) {
  if (file.status === "create") return `${file.path} (new file)`;
  if (file.status === "delete") return `${file.path} (deleted file)`;
  return file.path;
}

function getPatchFileBadge(file: PatchFileChange) {
  if (file.status === "create") return "NEW";
  if (file.status === "delete") return "DEL";

  const extension = getFileName(file.path).split(".").pop();
  return extension ? extension.slice(0, 3).toUpperCase() : "MOD";
}

function getFilteredSummary(patch: GenerateEditResponse) {
  const diagnostics = patch.diagnostics;
  if (!diagnostics || diagnostics.filteredCount <= 0) return null;

  // 审核区只展示过滤概览，详细原因留在任务历史里展开查看。
  return `模型候选 ${diagnostics.rawPatchCount} 项，最终有效 ${diagnostics.finalPatchCount} 项，已过滤 ${diagnostics.filteredCount} 项。`;
}

function getSafeEditRoleLabel(role: SafeEditFileRole) {
  return { required: "必要改动", supporting: "配套改动", validation_only: "仅建议验证", unverified: "范围待分析", expansion: "扩散改动" }[role];
}

export default function PatchReviewPane({ patch, loading, autoFix, onApply, onReject, onRunCommand, onRegenerateFile, onRegeneratePatch, onAnalyzeImpact, onRejectExpansionFiles }: Props) {
  const [selectedPath, setSelectedPath] = useState(() => patch.files[0]?.path || "");
  const [showImpactSummary, setShowImpactSummary] = useState(false);
  const [approvalPath, setApprovalPath] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    // 新补丁到达时默认展示第一个文件，避免保留上一次补丁中的旧选择。
    setSelectedPath(patch.files[0]?.path || "");
    setShowImpactSummary(false);
    setApprovalPath(undefined);
  }, [patch.patchId, patch.files]);

  const selectedFile = useMemo(() => patch.files.find((file) => file.path === selectedPath) || patch.files[0], [patch.files, selectedPath]);
  // 兼容旧响应：新接口统一返回 finalSummary，旧数据回退到 summary。
  const displaySummary = patch.finalSummary || patch.summary;
  const filteredSummary = getFilteredSummary(patch);
  const safeEditReport = patch.diagnostics?.safeEditReport;
  const selectedAssessment = safeEditReport?.files.find((file) => file.filePath === selectedFile?.path);
  const safeEditModel = useMemo(() => safeEditReport ? createSafeEditViewModel(safeEditReport) : null, [safeEditReport]);
  const selectedSafeEditModel = useMemo(
    () => safeEditReport && selectedFile ? createSafeEditViewModel(safeEditReport, [selectedFile.path]) : null,
    [safeEditReport, selectedFile]
  );
  const approvalModel = useMemo(
    () => safeEditReport ? createSafeEditViewModel(safeEditReport, approvalPath === null ? patch.files.map((file) => file.path) : approvalPath ? [approvalPath] : []) : null,
    [approvalPath, patch.files, safeEditReport]
  );

  function requestApply(filePath?: string) {
    const targetModel = filePath ? selectedSafeEditModel : safeEditModel;
    // 服务端对待分析补丁采用整体门禁，单文件入口也不能绕过。
    if (safeEditModel?.status === "needs_analysis" || targetModel?.status === "needs_analysis") return;
    if (targetModel?.requiresApproval) {
      setApprovalPath(filePath ?? null);
      return;
    }
    onApply(filePath, false);
  }

  return (
    <section className="diff-review-pane" aria-label="Diff review in editor">
      <div className="editor-tabbar diff-review-tabbar" role="tablist" aria-label="Changed files">
        {patch.files.map((file) => {
          const active = file.path === selectedFile?.path;

          return (
            <button key={file.path} type="button" role="tab" aria-selected={active} className={active ? "editor-tab active" : "editor-tab"} title={file.path} onClick={() => setSelectedPath(file.path)}>
              <span className="editor-tab-badge">{getPatchFileBadge(file)}</span>
              <span className="editor-tab-name">{getFileName(file.path)}</span>
            </button>
          );
        })}
      </div>

      <div className="diff-header diff-review-header">
        <div>
          <h2>Diff Preview</h2>
          <small>{displaySummary}</small>
          {/* 阶段 7：子代理来源标签 */}
          {patch.subagentId && (
            <span className="subagent-source-tag" title={`来源子代理：${patch.subagentId}`}>
              来源子代理
            </span>
          )}
        </div>
        <div className="diff-actions">
          <button type="button" className="icon-button" disabled={loading || safeEditModel?.status === "needs_analysis"} title={safeEditModel?.status === "needs_analysis" ? "需要先补充影响分析" : "Apply all"} aria-label="Apply all" onClick={() => requestApply()}>
            <Icon name="apply" />
          </button>
          <button type="button" className="icon-button" disabled={loading} title="Reject all" aria-label="Reject all" onClick={() => onReject()}>
            <Icon name="reject" />
          </button>
        </div>
      </div>

      {autoFix?.awaitingPatchId === patch.patchId ? (
        <section className="diff-auto-fix">
          <strong>
            Auto-fix attempt {autoFix.attempts} of {autoFix.maxAttempts}
          </strong>
          <span>Validation command: {autoFix.command}</span>
          <pre>{autoFix.lastFailureSummary}</pre>
        </section>
      ) : null}

      {filteredSummary ? <div className="diff-diagnostics">{filteredSummary}</div> : null}

      {safeEditModel ? (
        <section className={`diff-safe-edit ${safeEditModel.status}`} aria-live="polite">
          <div className="diff-safe-edit-heading">
            <div><span>Safe Editor</span><strong>{safeEditModel.title}</strong></div>
            <span className={`safe-edit-status ${safeEditModel.status}`}>{safeEditModel.status}</span>
          </div>
          <p>{safeEditModel.description}</p>
          <span>证据来源：{safeEditModel.evidenceLabels.join("、") || "尚未提供"}</span>
          {safeEditModel.files.some((file) => file.risks.length) ? (
            <ul className="safe-edit-file-risks">
              {safeEditModel.files.filter((file) => file.risks.length).map((file) => (
                <li key={file.filePath}>
                  <code>{file.filePath}</code>
                  <span>{file.risks.map((risk) => risk.message).join("；")}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="safe-edit-recovery-actions">
            {safeEditModel.status === "needs_analysis" ? <button type="button" disabled={loading} onClick={onAnalyzeImpact}>补充影响分析</button> : null}
            <button type="button" disabled={loading} onClick={onRegeneratePatch}>重新生成整个补丁</button>
            {safeEditModel.expansionFiles.length ? <button type="button" disabled={loading} onClick={() => onRejectExpansionFiles(safeEditModel.expansionFiles)}>拒绝计划外文件</button> : null}
            <button type="button" aria-expanded={showImpactSummary} onClick={() => setShowImpactSummary((visible) => !visible)}>查看影响分析摘要</button>
          </div>
          {showImpactSummary ? (
            <div className="safe-edit-impact-summary">
              <strong>范围证据{safeEditModel.evidenceComplete ? "完整" : "尚不完整"}</strong>
              {safeEditModel.diagnostics.length ? <ul>{safeEditModel.diagnostics.map((diagnostic) => <li key={diagnostic}>{diagnostic}</li>)}</ul> : <span>暂无额外诊断。</span>}
            </div>
          ) : null}
        </section>
      ) : null}

      {selectedFile ? (
        <>
          <div className="diff-file-toolbar diff-review-toolbar">
            <div>
              <strong>{getPatchFileLabel(selectedFile)}</strong>
              {selectedAssessment ? <span className={`safe-edit-role ${selectedAssessment.role}`}>{getSafeEditRoleLabel(selectedAssessment.role)}</span> : null}
              <span>{selectedFile.summary}</span>
            </div>
            <div className="diff-file-actions">
              <button type="button" disabled={loading} onClick={() => onRegenerateFile(selectedFile)}>
                重新生成此文件
              </button>
              {safeEditModel?.status === "needs_analysis" ? <span className="safe-edit-apply-blocked">待补充分析</span> : (
                <button type="button" disabled={loading} onClick={() => requestApply(selectedFile.path)}>
                  Accept
                </button>
              )}
              <button type="button" disabled={loading} onClick={() => onReject(selectedFile.path)}>
                Reject
              </button>
            </div>
          </div>
          <div className="diff-editor-host">
            {selectedFile.isBinary ? (
              <pre className="diff-binary-preview" dangerouslySetInnerHTML={{ __html: selectedFile.diffHtml }} />
            ) : (
              <DiffEditor
                height="100%"
                language={getLanguage(selectedFile.path)}
                original={selectedFile.oldContent}
                modified={selectedFile.newContent}
                originalModelPath={`before://${patch.patchId}/${selectedFile.path}`}
                modifiedModelPath={`after://${patch.patchId}/${selectedFile.path}`}
                options={{
                  // 这里是审阅视图，禁用编辑能力避免误把待审核补丁当成已打开文件修改。
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: false },
                  fontSize: 12,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true
                }}
              />
            )}
          </div>
        </>
      ) : (
        <div className="diff-empty">No changed file to review.</div>
      )}

      {patch.commandsToRun?.length ? (
        <section className="diff-commands diff-review-commands">
          <strong>Validation commands</strong>
          <span>Applying the complete patch starts validation automatically. Failed validation generates another reviewable repair patch.</span>
          {patch.commandsToRun.map((command) => (
            <div className="diff-command" key={command}>
              <code>{command}</code>
              <button type="button" disabled={loading} onClick={() => onRunCommand(command)}>
                Verify
              </button>
            </div>
          ))}
        </section>
      ) : null}

      {approvalModel ? (
        <SafeEditApprovalDialog
          open={approvalPath !== undefined}
          loading={loading}
          model={approvalModel}
          onCancel={() => setApprovalPath(undefined)}
          onConfirm={() => {
            const targetPath = approvalPath ?? undefined;
            setApprovalPath(undefined);
            onApply(targetPath, true);
          }}
        />
      ) : null}
    </section>
  );
}
