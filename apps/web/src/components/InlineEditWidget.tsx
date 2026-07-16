import type { InlineEditCandidate } from "../api";
import type { InlineEditStatus } from "../hooks/useInlineEdit";

type Props = {
  instruction: string;
  status: InlineEditStatus;
  generatedCharacters: number;
  streamedReplacement: string;
  candidate: InlineEditCandidate | null;
  conflict: boolean;
  error: string | null;
  onInstructionChange: (value: string) => void;
  onGenerate: () => void;
  onAccept: () => void;
  onAcceptAndValidate: () => void;
  onReject: () => void;
  onStop: () => void;
};

export default function InlineEditWidget({ instruction, status, generatedCharacters, streamedReplacement, candidate, conflict, error, onInstructionChange, onGenerate, onAccept, onAcceptAndValidate, onReject, onStop }: Props) {
  return (
    <section className="inline-edit-widget" aria-label="AI 内联编辑" aria-live="polite">
      <div className="inline-edit-widget-title">
        <strong>Inline Edit</strong>
        <span>{status === "generating" ? `正在生成 · ${generatedCharacters} 字符` : candidate ? "候选已就绪" : status === "stopped" ? "已停止" : "描述局部修改"}</span>
      </div>
      <textarea
        autoFocus
        value={instruction}
        disabled={status === "generating"}
        placeholder="例如：简化这段判断并保留现有行为"
        aria-label="Inline Edit 修改要求"
        onChange={(event) => onInstructionChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); onGenerate(); }
          if (event.key === "Escape") { event.preventDefault(); candidate ? onReject() : onStop(); }
        }}
      />
      {candidate?.explanation ? <p className="inline-edit-explanation">{candidate.explanation}</p> : null}
      {status === "generating" && streamedReplacement ? <p className="inline-edit-stream-state">候选内容正在实时更新…</p> : null}
      {conflict ? <p className="inline-edit-error">文档在生成后已变化，不能直接接受，请重新生成。</p> : null}
      {error ? <p className="inline-edit-error">{error}</p> : null}
      <div className="inline-edit-actions">
        {status === "generating" ? <button type="button" onClick={onStop}>停止（Esc）</button> : (
          <button type="button" disabled={!instruction.trim()} onClick={onGenerate}>{candidate ? "重新生成" : "生成"}（Ctrl+Enter）</button>
        )}
        {candidate ? <button type="button" className="primary" disabled={conflict} onClick={onAccept}>接受（Alt+Enter）</button> : null}
        {candidate ? <button type="button" className="primary" disabled={conflict} onClick={onAcceptAndValidate}>接受并验证</button> : null}
        <button type="button" onClick={onReject}>拒绝（Esc）</button>
      </div>
      <span className="sr-only">可使用 Ctrl 加 Enter 生成，Alt 加 Enter 接受，Escape 停止或拒绝。</span>
    </section>
  );
}
