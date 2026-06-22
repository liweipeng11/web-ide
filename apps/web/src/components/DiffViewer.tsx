import { useEffect, useState } from "react";
import type { GenerateEditResponse } from "../api";
import type { AutoFixState } from "../appState";
import Icon from "./Icon";

type Props = {
  patch: GenerateEditResponse | null;
  loading: boolean;
  onApply: (filePath?: string) => void;
  onReject: (filePath?: string) => void;
  onRunCommand: (command: string) => void;
  autoFix: AutoFixState | null;
};

export default function DiffViewer({ patch, loading, onApply, onReject, onRunCommand, autoFix }: Props) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (patch) {
      setOpen(true);
    }
  }, [patch?.patchId]);

  if (!patch) {
    return null;
  }

  return (
    <>
      <button className="diff-fab icon-button" type="button" title="View Diff" aria-label="View Diff" onClick={() => setOpen(true)}>
        <Icon name="diff" />
      </button>
      {open && (
        <div className="diff-modal-backdrop" role="presentation">
          <section className="diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-modal-title">
            <div className="diff-header">
              <div>
                <h2 id="diff-modal-title">Diff Preview</h2>
                <span>{patch.summary}</span>
                <small>{patch.files.length} file{patch.files.length === 1 ? "" : "s"} changed</small>
              </div>
              <div className="diff-actions">
                <button type="button" className="icon-button" title="Close" aria-label="Close" onClick={() => setOpen(false)}>
                  <Icon name="close" />
                </button>
                <button type="button" className="icon-button" disabled={loading} title="Apply all" aria-label="Apply all" onClick={() => onApply()}>
                  <Icon name="apply" />
                </button>
                <button type="button" className="icon-button" disabled={loading} title="Reject all" aria-label="Reject all" onClick={() => onReject()}>
                  <Icon name="reject" />
                </button>
              </div>
            </div>
            <div className="diff-body">
              {autoFix?.awaitingPatchId === patch.patchId ? (
                <section className="diff-auto-fix">
                  <strong>
                    Auto-fix attempt {autoFix.attempts} of {autoFix.maxAttempts}
                  </strong>
                  <span>Validation command: {autoFix.command}</span>
                  <pre>{autoFix.lastFailureSummary}</pre>
                </section>
              ) : null}
              {patch.files.map((file) => (
                <section className="diff-file" key={file.path}>
                  <div className="diff-file-toolbar">
                    <div>
                      <strong>{file.path}{file.status === "create" ? " (new file)" : ""}</strong>
                      <span>{file.summary}</span>
                    </div>
                    <div className="diff-file-actions">
                      <button type="button" disabled={loading} onClick={() => onApply(file.path)}>
                        Accept
                      </button>
                      <button type="button" disabled={loading} onClick={() => onReject(file.path)}>
                        Reject
                      </button>
                    </div>
                  </div>
                  <pre dangerouslySetInnerHTML={{ __html: file.diffHtml }} />
                </section>
              ))}
              {patch.commandsToRun?.length ? (
                <section className="diff-commands">
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
            </div>
          </section>
        </div>
      )}
    </>
  );
}
