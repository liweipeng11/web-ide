import { useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { GenerateEditResponse, PatchFileChange, SafeEditFileRole } from "../api";
import type { AutoFixState } from "../appState";
import Icon from "./Icon";

type Props = {
  patch: GenerateEditResponse;
  loading: boolean;
  autoFix: AutoFixState | null;
  onApply: (filePath?: string) => void;
  onReject: (filePath?: string) => void;
  onRunCommand: (command: string) => void;
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
  return { required: "必要改动", supporting: "配套改动", validation_only: "仅建议验证", expansion: "扩散改动" }[role];
}

export default function PatchReviewPane({ patch, loading, autoFix, onApply, onReject, onRunCommand }: Props) {
  const [selectedPath, setSelectedPath] = useState(() => patch.files[0]?.path || "");

  useEffect(() => {
    // 新补丁到达时默认展示第一个文件，避免保留上一次补丁中的旧选择。
    setSelectedPath(patch.files[0]?.path || "");
  }, [patch.patchId, patch.files]);

  const selectedFile = useMemo(() => patch.files.find((file) => file.path === selectedPath) || patch.files[0], [patch.files, selectedPath]);
  // 兼容旧响应：新接口统一返回 finalSummary，旧数据回退到 summary。
  const displaySummary = patch.finalSummary || patch.summary;
  const filteredSummary = getFilteredSummary(patch);
  const safeEditReport = patch.diagnostics?.safeEditReport;
  const selectedAssessment = safeEditReport?.files.find((file) => file.filePath === selectedFile?.path);

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
        </div>
        <div className="diff-actions">
          <button type="button" className="icon-button" disabled={loading} title="Apply all" aria-label="Apply all" onClick={() => onApply()}>
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

      {safeEditReport && safeEditReport.status !== "clean" ? (
        <section className={`diff-safe-edit ${safeEditReport.status}`}>
          <strong>Safe Editor：{safeEditReport.status === "high_risk" ? "检测到高风险扩散" : "存在需要确认的改动"}</strong>
          <span>
            证据来源：{safeEditReport.recommendation.evidenceSource === "impact_analysis" ? "影响分析" : safeEditReport.recommendation.evidenceSource === "explicit_target" ? "明确目标文件" : "缺少影响分析"}
          </span>
          {safeEditReport.risks.length ? <ul>{safeEditReport.risks.map((risk, index) => <li key={`${risk.filePath}:${risk.kind}:${index}`}><code>{risk.filePath}</code> {risk.message}</li>)}</ul> : null}
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
              <button type="button" disabled={loading} onClick={() => onApply(selectedFile.path)}>
                Accept
              </button>
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
    </section>
  );
}
