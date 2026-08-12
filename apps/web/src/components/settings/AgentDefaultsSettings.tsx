import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ModelCatalogResponse, ModelSelection, ModelSelectionDefaults } from "../../api";

type Props = {
  defaults: ModelSelectionDefaults | null;
  catalog: ModelCatalogResponse | null;
  saving: boolean;
  onSave: (defaults: ModelSelectionDefaults) => Promise<void>;
};

const modelPurpose = {
  chat: { title: "日常对话", description: "解释代码、回答问题和轻量分析" },
  plan: { title: "规划阶段", description: "拆解任务、评估影响和生成实施方案" },
  act: { title: "实施阶段", description: "调用工具、生成补丁并执行验证" }
} as const;

function serializeSelection(selection: ModelSelection) {
  return JSON.stringify(selection);
}

/** 配置新会话行为和三种智能体阶段使用的默认模型。 */
export default function AgentDefaultsSettings({ defaults, catalog, saving, onSave }: Props) {
  const [draft, setDraft] = useState(defaults);
  const [feedback, setFeedback] = useState("");
  const availableProviders = useMemo(
    () => (catalog?.providers || []).filter((provider) => provider.models.some((model) => !model.disabledReason)),
    [catalog]
  );

  useEffect(() => setDraft(defaults), [defaults]);

  function updateModel(purpose: keyof ModelSelectionDefaults, value: string) {
    if (!draft) return;
    setDraft({ ...draft, [purpose]: JSON.parse(value) as ModelSelection });
    setFeedback("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setFeedback("");
    try {
      await onSave(draft);
      setFeedback("智能体默认值已保存");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "保存智能体默认值失败");
    }
  }

  return (
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <header className="settings-content-header">
        <div>
          <h1>智能体默认值</h1>
          <p>设置新对话的初始工作方式，以及不同阶段优先使用的模型。</p>
        </div>
      </header>

      <section className="settings-card">
        <div className="settings-card-heading">
          <div><h2>默认模型</h2><p>按任务阶段分别选择，Provider 中停用或不可用的模型不会出现在列表中。</p></div>
        </div>
        <div className="settings-field-list">
          {(Object.keys(modelPurpose) as Array<keyof ModelSelectionDefaults>).map((purpose) => (
            <label className="settings-field-row" key={purpose}>
              <span><strong>{modelPurpose[purpose].title}</strong><small>{modelPurpose[purpose].description}</small></span>
              <select disabled={!draft || !availableProviders.length} value={draft ? serializeSelection(draft[purpose]) : ""} onChange={(event) => updateModel(purpose, event.target.value)}>
                {availableProviders.map((provider) => (
                  <optgroup key={provider.id} label={provider.id}>
                    {provider.models.filter((model) => !model.disabledReason).map((model) => (
                      <option key={`${provider.id}:${model.id}`} value={serializeSelection({ providerId: provider.id, modelId: model.id })}>{model.displayName}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      <footer className="settings-form-footer">
        <span>{feedback || (!defaults ? "正在加载模型配置..." : "设置会用于后续新任务")}</span>
        <button type="submit" disabled={saving || !draft}>{saving ? "保存中..." : "保存默认值"}</button>
      </footer>
    </form>
  );
}
