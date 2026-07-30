import { useEffect } from "react";
import type { SafeEditViewModel } from "./safeEditViewModel";

type Props = {
  open: boolean;
  loading: boolean;
  model: SafeEditViewModel;
  onCancel: () => void;
  onConfirm: () => void;
};

/** 仅用于确认真实范围扩散；待分析状态不会进入此审批流程。 */
export default function SafeEditApprovalDialog({ open, loading, model, onCancel, onConfirm }: Props) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loading, onCancel, open]);

  if (!open || model.status !== "high_risk") return null;

  return (
    <div className="safe-edit-dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onCancel()}>
      <section className="safe-edit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="safe-edit-dialog-title" aria-describedby="safe-edit-dialog-description">
        <header>
          <span className="safe-edit-dialog-kicker">Safe Editor 结构化审批</span>
          <h2 id="safe-edit-dialog-title">确认应用范围扩散修改？</h2>
          <p id="safe-edit-dialog-description">该操作会应用已确认超出计划范围的文件。请逐项核对目标、证据和风险。</p>
        </header>

        <div className="safe-edit-dialog-body">
          <dl className="safe-edit-approval-facts">
            <div><dt>证据来源</dt><dd>{model.evidenceLabels.join("、") || "未提供"}</dd></div>
            <div><dt>验证结果</dt><dd>{model.evidenceComplete ? "范围证据完整" : "范围证据不完整"}</dd></div>
          </dl>
          <div className="safe-edit-approval-files">
            {model.files.map((file) => (
              <article key={file.filePath}>
                <div><code>{file.filePath}</code><span className={`safe-edit-role ${file.role}`}>{file.roleLabel}</span></div>
                {file.reasons.length ? <p>{file.reasons.join("；")}</p> : null}
                {file.risks.length ? <ul>{file.risks.map((risk) => <li key={`${risk.kind}:${risk.message}`}>{risk.message}</li>)}</ul> : null}
              </article>
            ))}
          </div>
        </div>

        <footer>
          <button type="button" autoFocus disabled={loading} onClick={onCancel}>返回审核</button>
          <button type="button" className="danger" disabled={loading} onClick={onConfirm}>{loading ? "正在应用…" : "确认风险并应用"}</button>
        </footer>
      </section>
    </div>
  );
}

