import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { testProviderConnection } from "../../api";
import Icon from "../Icon";

type Props = {
  open: boolean;
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiKey: string;
  selectedModels: string[];
  onClose: () => void;
  onApply: (models: string[]) => void;
};

/** 管理 Provider 模型目录，并将用户选择回填到设置表单。 */
export default function ProviderModelManagerModal({ open, providerId, providerName, baseUrl, apiKey, selectedModels, onClose, onApply }: Props) {
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [draftModels, setDraftModels] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState("");

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    // 保留已配置但 Provider 当前目录未返回的模型，避免打开弹窗后静默丢失配置。
    return [...new Set([...availableModels, ...draftModels])].filter((model) => !query || model.toLowerCase().includes(query));
  }, [availableModels, draftModels, search]);

  async function loadModels() {
    setLoading(true);
    setFeedback("");
    try {
      const result = await testProviderConnection({ providerId, baseUrl, apiKey });
      if (!result.available) {
        setFeedback(result.message);
        return;
      }
      setAvailableModels(result.models);
      setFeedback(result.models.length ? `已获取 ${result.models.length} 个模型` : "Provider 未返回模型列表");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "模型列表获取失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setDraftModels([...selectedModels]);
    setAvailableModels([]);
    setSearch("");
    void loadModels();
    // 弹窗每次打开时使用当时的表单配置重新加载，关闭期间无需同步内部草稿。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId]);

  if (!open) return null;

  function toggleModel(model: string) {
    if (draftModels.includes(model)) {
      if (draftModels.length <= 1) {
        setFeedback("至少需要保留一个模型");
        return;
      }
      setDraftModels((current) => current.filter((item) => item !== model));
    } else {
      setDraftModels((current) => [...current, model]);
    }
    setFeedback("");
  }

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !loading) onClose();
  }

  return (
    <div className="provider-model-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section className="provider-model-modal" role="dialog" aria-modal="true" aria-labelledby="provider-model-title">
        <header>
          <div>
            <h2 id="provider-model-title">{providerName} 模型</h2>
            <p>从 Provider 获取全部模型，并选择要在工作区中使用的模型。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭模型管理" disabled={loading} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div className="provider-model-toolbar">
          <label>
            <Icon name="search" />
            <input value={search} placeholder="搜索模型 ID 或名称" autoFocus onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="button" disabled={loading} onClick={() => void loadModels()}>{loading ? "刷新中..." : "刷新"}</button>
        </div>

        <div className="provider-model-summary">
          <span>全部 {visibleModels.length}</span>
          <span>已添加 {draftModels.length}</span>
        </div>

        <div className="provider-model-list">
          {visibleModels.map((model) => {
            const selected = draftModels.includes(model);
            const remoteAvailable = availableModels.includes(model);
            return (
              <div key={model} className={selected ? "selected" : ""}>
                <span className="provider-avatar">{model.slice(0, 1).toUpperCase()}</span>
                <span>
                  <strong>{model}</strong>
                  <small>{remoteAvailable ? "Provider 模型" : "已配置，当前目录未返回"}</small>
                </span>
                <button type="button" className={selected ? "remove" : "add"} aria-label={`${selected ? "移除" : "添加"}模型 ${model}`} onClick={() => toggleModel(model)}>
                  {selected ? "−" : "+"}
                </button>
              </div>
            );
          })}
          {!visibleModels.length && !loading ? <p>没有匹配的模型</p> : null}
          {loading ? <p>正在获取 Provider 模型列表...</p> : null}
        </div>

        <footer>
          <small>{feedback || "加号添加模型，减号移除模型"}</small>
          <div>
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" disabled={!draftModels.length} onClick={() => { onApply(draftModels); onClose(); }}>确定</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
