import { useEffect, useMemo, useState, type FormEvent } from "react";
import { testProviderConnection, type CreateProviderInput, type ModelCatalogResponse, type ProviderSettings, type ProviderSettingsInput } from "../../api";
import AddProviderModal from "./AddProviderModal";
import ProviderModelManagerModal from "./ProviderModelManagerModal";

 type Props = {
 settings: ProviderSettings[];
  catalog: ModelCatalogResponse | null;
  loading: boolean;
  onSave: (input: ProviderSettingsInput) => Promise<void>;
  onCreate: (input: CreateProviderInput) => Promise<ProviderSettings>;
};

/** Provider 独立设置页，负责提供商导航、连接配置和模型目录管理。 */
export default function ProviderSettingsPage({ settings, catalog, loading, onSave, onCreate }: Props) {
  const [selectedId, setSelectedId] = useState("");
  const [providerSearch, setProviderSearch] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [showModelManager, setShowModelManager] = useState(false);
  const [feedback, setFeedback] = useState("");
  const selected = settings.find((provider) => provider.providerId === selectedId) || settings[0] || null;
  const catalogProvider = catalog?.providers.find((provider) => provider.id === selected?.providerId);
  const visibleProviders = useMemo(() => {
    const query = providerSearch.trim().toLowerCase();
    return settings.filter((provider) => !query || provider.name.toLowerCase().includes(query) || provider.providerId.toLowerCase().includes(query));
  }, [providerSearch, settings]);

  useEffect(() => {
    if (!selectedId && settings.length) setSelectedId(settings[0].providerId);
    if (selectedId && !settings.some((provider) => provider.providerId === selectedId)) setSelectedId(settings[0]?.providerId || "");
  }, [selectedId, settings]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setBaseUrl(selected.baseUrl);
    setApiKey("");
    setModels([...selected.models]);
    setEnabled(selected.enabled);
    setFeedback("");
  }, [selected]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const normalizedModels = models.map((model) => model.trim());
    if (!name.trim() || normalizedModels.some((model) => !model) || new Set(normalizedModels).size !== normalizedModels.length) {
      setFeedback("请检查提供商名称和模型 ID，模型不能为空或重复");
      return;
    }
    setSaving(true);
    setFeedback("");
    try {
      await onSave({
        providerId: selected.providerId,
        name: name.trim(),
        type: selected.type,
        baseUrl,
        apiKey,
        models: normalizedModels,
        enabled
      });
      setApiKey("");
      setFeedback("Provider 设置已保存");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Provider 设置保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (!selected) return;
    setTesting(true);
    setFeedback("");
    try {
      const result = await testProviderConnection({ providerId: selected.providerId, baseUrl, apiKey });
      setFeedback(result.message);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Provider 检测失败");
    } finally {
      setTesting(false);
    }
  }

  async function create(input: CreateProviderInput) {
    setCreating(true);
    try {
      const provider = await onCreate(input);
      setSelectedId(provider.providerId);
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="provider-settings-panel">
      <aside className="provider-page-sidebar">
        <div className="provider-page-brand">
          <strong>模型平台</strong>
          <span>{settings.length}</span>
        </div>
        <input value={providerSearch} placeholder="搜索模型平台..." aria-label="搜索模型平台" onChange={(event) => setProviderSearch(event.target.value)} />
        <div className="provider-page-list">
          {visibleProviders.map((provider) => (
            <button key={provider.providerId} type="button" className={provider.providerId === selected?.providerId ? "active" : ""} onClick={() => setSelectedId(provider.providerId)}>
              <span className="provider-avatar">{provider.name.slice(0, 1).toUpperCase()}</span>
              <span className="provider-page-item-copy"><strong>{provider.name}</strong><small>{provider.providerId}</small></span>
              <span className={provider.credentialConfigured && provider.enabled ? "provider-status on" : "provider-status"}>{provider.credentialConfigured && provider.enabled ? "ON" : "待配置"}</span>
            </button>
          ))}
          {!visibleProviders.length ? <p>没有匹配的 Provider</p> : null}
        </div>
        <button type="button" className="provider-add-button" onClick={() => setShowAddProvider(true)}>＋ 添加</button>
      </aside>

      <section className="provider-page-detail">
        <header className="provider-page-header">
          <div><h1>{selected?.name || "Provider 设置"}</h1><span>{selected?.providerId || "请选择提供商"}</span></div>
          <div className="provider-page-header-actions">
            {selected ? <button type="button" className={enabled ? "provider-enable-switch on" : "provider-enable-switch"} role="switch" aria-checked={enabled} onClick={() => setEnabled((value) => !value)}><span /></button> : null}
          </div>
        </header>

        {selected ? (
          <form className="provider-page-form" onSubmit={(event) => void save(event)}>
            <section>
              <div className="provider-page-section-title"><div><h2>API 密钥</h2><p>{selected.credentialConfigured ? `已配置 ${selected.credentialPreview}` : "尚未配置访问凭据"}</p></div></div>
              <div className="provider-page-key-row">
                <input type="password" value={apiKey} placeholder={selected.credentialConfigured ? "留空以保留当前密钥" : "请输入 API Key"} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} />
                <button type="button" disabled={loading || saving || testing} onClick={() => void testConnection()}>{testing ? "检测中..." : "检测"}</button>
              </div>
            </section>

            <section>
              <div className="provider-page-section-title"><div><h2>API 地址</h2><p>请求预览：{baseUrl.replace(/\/$/, "")}/chat/completions</p></div></div>
              <input type="url" required value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </section>

            <section>
              <div className="provider-page-section-title">
                <div><h2>模型 <span>{models.length}</span></h2><p>{catalogProvider?.health.available ? "Provider 当前可用" : catalogProvider?.health.message || "检测连接后可管理 Provider 模型"}</p></div>
              </div>
              <div className="provider-page-model-preview">
                {models.slice(0, 6).map((model) => <span key={model}>{model}</span>)}
                {models.length > 6 ? <span>还有 {models.length - 6} 个</span> : null}
              </div>
              <button type="button" className="provider-model-manage-button" disabled={loading || saving || testing} onClick={() => setShowModelManager(true)}>管理模型</button>
            </section>

            <footer className="provider-page-footer">
              <small>{feedback || "修改后请保存设置"}</small>
              <button type="submit" disabled={loading || saving}>{saving ? "保存中..." : "保存设置"}</button>
            </footer>
          </form>
        ) : <div className="provider-page-empty">请先添加一个 Provider</div>}
      </section>

      <AddProviderModal open={showAddProvider} saving={creating} onClose={() => setShowAddProvider(false)} onCreate={create} />
      {selected ? (
        <ProviderModelManagerModal
          open={showModelManager}
          providerId={selected.providerId}
          providerName={name || selected.name}
          baseUrl={baseUrl}
          apiKey={apiKey}
          selectedModels={models}
          onClose={() => setShowModelManager(false)}
          onApply={(nextModels) => { setModels(nextModels); setFeedback(`已更新 ${nextModels.length} 个模型，请保存设置`); }}
        />
      ) : null}
    </div>
  );
}
