import { useState, type FormEvent } from "react";
import type { ProjectMemoryItem, PromoteMemoryInput } from "../../api";

type Props = { item: ProjectMemoryItem; busy: boolean; onCancel: () => void; onConfirm: (input: PromoteMemoryInput) => Promise<void> };

export function MemoryPromotionDialog({ item, busy, onCancel, onConfirm }: Props) {
  const [ruleFile, setRuleFile] = useState(`memory-${item.id.slice(0, 8)}.md`);
  const [scope, setScope] = useState<"project" | "path">(item.scope.type);
  const [paths, setPaths] = useState(item.scope.paths.join("\n"));
  const [alwaysApply, setAlwaysApply] = useState(item.scope.type === "project");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedPaths = [...new Set(paths.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    const target = `.mini-ai/rules/${ruleFile}`;
    if (!window.confirm(`再次确认：将写入 ${target}。Project Rule 会作为可信指令${alwaysApply ? "始终" : "按路径"}生效，是否继续？`)) return;
    await onConfirm({ ruleFile, scope, paths: scope === "path" ? normalizedPaths : [], alwaysApply, confirmed: true });
  }

  return (
    <form className="memory-promotion" onSubmit={(event) => void submit(event)}>
      <div className="memory-section-heading"><div><h4>提升为 Project Rule</h4><p>此操作会创建可信规则文件，请核对全部字段</p></div></div>
      <label>目标规则文件<div className="memory-rule-path"><code>.mini-ai/rules/</code><input required pattern="[a-z0-9][a-z0-9._-]*\.md" value={ruleFile} onChange={(event) => setRuleFile(event.target.value.toLowerCase())} /></div></label>
      <label>规则作用域<select value={scope} onChange={(event) => { const next = event.target.value as "project" | "path"; setScope(next); if (next === "path") setAlwaysApply(false); }}><option value="project">整个项目</option><option value="path">指定路径</option></select></label>
      {scope === "path" && <label>路径匹配范围<textarea rows={2} required value={paths} onChange={(event) => setPaths(event.target.value)} /></label>}
      <label className="memory-check"><input type="checkbox" checked={alwaysApply} disabled={scope === "path"} onChange={(event) => setAlwaysApply(event.target.checked)} />始终生效</label>
      <div className="memory-rule-preview"><small>即将写入的规则内容</small><pre>{item.content}</pre></div>
      <div className="memory-actions"><button type="button" disabled={busy} onClick={onCancel}>取消</button><button type="submit" className="danger" disabled={busy || !ruleFile || (scope === "path" && !paths.trim())}>确认并创建规则</button></div>
    </form>
  );
}
