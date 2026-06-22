import type { ProjectRulesResponse } from "../api";

type Props = {
  disabled: boolean;
  rules: ProjectRulesResponse | null;
  onRefresh: () => void;
};

const sourceLabels: Record<string, string> = {
  agents: "Agent",
  cursor: "Cursor",
  windsurf: "Windsurf",
  "mini-ai": "Mini AI"
};

const scopeLabels: Record<string, string> = {
  global: "Global",
  project: "Project",
  legacy: "Legacy"
};

export default function ProjectRulesPanel({ disabled, rules, onRefresh }: Props) {
  const activeRules = rules?.rules.filter((rule) => rule.active) || [];

  return (
    <section className="project-rules-panel">
      <div className="project-rules-heading">
        <div>
          <h2>Project Rules</h2>
          <p>{disabled ? "Open a workspace to discover rules." : `${activeRules.length}/${rules?.rules.length || 0} active`}</p>
        </div>
        <button type="button" disabled={disabled} onClick={onRefresh}>
          Refresh
        </button>
      </div>

      <div className="project-rules-supported">
        <strong>Supported</strong>
        {(rules?.supportedFiles || ["~/.mini-ai/AGENTS.md", "~/.mini-ai/rules/*.md", ".mini-ai/AGENTS.md", ".mini-ai/rules/*.md"]).map((file) => (
          <code key={file}>{file}</code>
        ))}
      </div>

      {!disabled && !rules?.rules.length && (
        <div className="project-rules-empty">
          <strong>No rules found yet.</strong>
          <span>Create global rules in `~/.mini-ai` or project rules in the workspace `.mini-ai` folder to guide the agent.</span>
        </div>
      )}

      <div className="project-rules-list">
        {(rules?.rules || []).map((rule) => (
          <article key={`${rule.scope}:${rule.path}`} className={rule.active ? "project-rule-card active" : "project-rule-card"}>
            <div className="project-rule-card-header">
              <div>
                <strong>{rule.title}</strong>
                <span>{rule.path}</span>
              </div>
              <mark>{rule.active ? "Active" : "Scoped"}</mark>
            </div>
            <div className="project-rule-meta">
              <span>{scopeLabels[rule.scope] || rule.scope}</span>
              <span>{sourceLabels[rule.source] || rule.source}</span>
              <span>{rule.alwaysApply ? "alwaysApply" : rule.globs.join(", ") || "global"}</span>
              {rule.truncated && <span>truncated</span>}
            </div>
            <pre>{rule.content || "(empty rule file)"}</pre>
          </article>
        ))}
      </div>
    </section>
  );
}
