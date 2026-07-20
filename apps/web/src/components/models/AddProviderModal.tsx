import { useState, type FormEvent, type MouseEvent } from "react";
import type { CreateProviderInput } from "../../api";
import Icon from "../Icon";

type Props = {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onCreate: (input: CreateProviderInput) => Promise<void>;
};

/** 新增提供商弹窗，仅负责采集提供商基础信息。 */
export default function AddProviderModal({ open, saving, onClose, onCreate }: Props) {
  const [name, setName] = useState("");
  const [feedback, setFeedback] = useState("");

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setFeedback("请输入提供商名称");
      return;
    }
    setFeedback("");
    try {
      await onCreate({ name: name.trim(), type: "openai-compatible" });
      setName("");
      onClose();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "新增提供商失败");
    }
  }

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !saving) onClose();
  }

  return (
    <div className="add-provider-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section className="add-provider-modal" role="dialog" aria-modal="true" aria-labelledby="add-provider-title">
        <header>
          <h2 id="add-provider-title">添加提供商</h2>
          <button type="button" className="icon-button" aria-label="关闭" disabled={saving} onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <div className="add-provider-avatar">P</div>
          <label>
            <span>提供商名称</span>
            <input value={name} disabled={saving} placeholder="例如 OpenAI" autoFocus onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>提供商类型</span>
            <select value="openai-compatible" disabled>
              <option value="openai-compatible">OpenAI Compatible</option>
            </select>
          </label>
          {feedback ? <p>{feedback}</p> : null}
          <footer>
            <button type="button" disabled={saving} onClick={onClose}>取消</button>
            <button type="submit" disabled={saving || !name.trim()}>{saving ? "添加中..." : "确定"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
