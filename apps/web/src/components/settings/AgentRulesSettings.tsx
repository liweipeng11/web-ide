import { useEffect, useState, type FormEvent } from "react";
import { fetchAgentRulesSettings, updateAgentRulesSettings, type AgentRulesSettings as AgentRulesSettingsData, type ProjectRulesResponse } from "../../api";

type Props = {
  discoveredRules: ProjectRulesResponse | null;
  onRefreshDiscoveredRules: () => Promise<void>;
};

/** 编辑智能体始终读取的主规则文件，并展示其他自动发现的规则。 */
export default function AgentRulesSettings({ discoveredRules, onRefreshDiscoveredRules }: Props) {
  const [settings, setSettings] = useState<AgentRulesSettingsData | null>(null);
  const [globalContent, setGlobalContent] = useState("");
  const [projectContent, setProjectContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function load() {
    setLoading(true);
    setFeedback("");
    try {
      const result = await fetchAgentRulesSettings();
      setSettings(result.settings);
      setGlobalContent(result.settings.global.content);
      setProjectContent(result.settings.project.content);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "加载 Agent Rules 失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback("");
    try {
      const result = await updateAgentRulesSettings({
        globalContent,
        ...(settings?.project.available ? { projectContent } : {})
      });
      setSettings(result.settings);
      await onRefreshDiscoveredRules();
      setFeedback("Agent Rules 已保存，将从下一次智能体请求开始生效");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "保存 Agent Rules 失败");
    } finally {
      setSaving(false);
    }
  }

  const additionalRules = (discoveredRules?.rules || []).filter((rule) => !["~/.mini-ai/AGENTS.md", ".mini-ai/AGENTS.md"].includes(rule.path));

  return (
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <header className="settings-content-header">
        <div>
          <h1>Agent Rules</h1>
          <p>为所有项目或当前工作区定义持续生效的智能体约束和编码规范。</p>
        </div>
        <button type="button" className="settings-secondary-button" disabled={loading || saving} onClick={() => void load()}>重新加载</button>
      </header>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div><h2>全局规则</h2><p>{settings?.global.path || "~/.mini-ai/AGENTS.md"} · 对所有工作区生效</p></div>
          <span>{globalContent.length.toLocaleString()} / 20,000</span>
        </div>
        <textarea disabled={loading} maxLength={20_000} value={globalContent} placeholder="例如：生成代码时使用中文注释，并保持修改范围聚焦。" onChange={(event) => setGlobalContent(event.target.value)} />
      </section>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div><h2>项目规则</h2><p>{settings?.project.path || ".mini-ai/AGENTS.md"} · 仅对当前工作区生效</p></div>
          <span>{projectContent.length.toLocaleString()} / 20,000</span>
        </div>
        <textarea disabled={loading || !settings?.project.available} maxLength={20_000} value={projectContent} placeholder={settings?.project.available ? "记录当前项目专属的技术栈、目录和实现约束。" : "打开工作区后可配置项目规则"} onChange={(event) => setProjectContent(event.target.value)} />
      </section>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div><h2>其他已发现规则</h2><p>包括 `.mini-ai/rules/*.md` 和兼容的旧规则文件；请在对应文件中维护。</p></div>
          <button type="button" className="settings-secondary-button" disabled={!settings?.project.available} onClick={() => void onRefreshDiscoveredRules()}>刷新发现</button>
        </div>
        <div className="settings-rule-list">
          {additionalRules.map((rule) => (
            <article key={`${rule.scope}:${rule.path}`}>
              <div><strong>{rule.title}</strong><small>{rule.path}</small></div>
              <span className={rule.active ? "active" : ""}>{rule.active ? "已生效" : "按范围"}</span>
            </article>
          ))}
          {!additionalRules.length ? <p>当前没有发现其他规则文件。</p> : null}
        </div>
      </section>

      <footer className="settings-form-footer">
        <span>{feedback || "规则保存后无需重启服务"}</span>
        <button type="submit" disabled={loading || saving}>{saving ? "保存中..." : "保存 Agent Rules"}</button>
      </footer>
    </form>
  );
}
