import { useState } from "react";
import type { GenerateEditResponse } from "../api";
import Icon from "./Icon";

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
      <button className="diff-fab icon-button" type="button" title="查看 Diff" aria-label="查看 Diff" onClick={() => setOpen(true)}>
        <Icon name="diff" />
      </button>
      {open && (
        <div className="diff-modal-backdrop" role="presentation">
          <section className="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title">
            <div className="diff-header">
              <div>
                <h2 id="diff-modal-title">Diff 预览</h2>
                <span>{patch.summary}</span>
                <small>{patch.files.length} file{patch.files.length === 1 ? "" : "s"} changed</small>
              </div>
              <div className="diff-actions">
                <button type="button" className="icon-button" title="关闭" aria-label="关闭" onClick={() => setOpen(false)}>
                  <Icon name="close" />
                </button>
                <button type="button" className="icon-button" disabled={loading} title="应用" aria-label="应用" onClick={onApply}>
                  <Icon name="apply" />
                </button>
                <button type="button" className="icon-button" disabled={loading} title="拒绝" aria-label="拒绝" onClick={onReject}>
                  <Icon name="reject" />
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
