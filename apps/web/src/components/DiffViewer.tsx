import { useState } from "react";
import type { GenerateEditResponse } from "../api";

type Props = {
  patch: GenerateEditResponse | null;
  loading: boolean;
  onApply: () => void;
  onReject: () => void;
};

export default function DiffViewer({ patch, loading, onApply, onReject }: Props) {
  const [open, setOpen] = useState(false);

  if (!patch) {
    return null;
  }

  return (
    <>
      <button className="diff-fab" type="button" onClick={() => setOpen(true)}>
        查看 Diff
      </button>
      {open && (
        <div className="diff-modal-backdrop" role="presentation">
          <section className="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title">
            <div className="diff-header">
              <div>
                <h2 id="diff-modal-title">Diff 预览</h2>
                <span>{patch.summary}</span>
              </div>
              <div className="diff-actions">
                <button type="button" onClick={() => setOpen(false)}>
                  关闭
                </button>
                <button type="button" disabled={loading} onClick={onApply}>
                  应用
                </button>
                <button type="button" disabled={loading} onClick={onReject}>
                  拒绝
                </button>
              </div>
            </div>
            <div className="diff-body">
              <pre dangerouslySetInnerHTML={{ __html: patch.diffHtml }} />
            </div>
          </section>
        </div>
      )}
    </>
  );
}
