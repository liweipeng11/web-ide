import { lazy, Suspense } from "react";
import type { CreateProviderInput, ModelCatalogResponse, ModelSelectionDefaults, ProjectRulesResponse, ProviderSettings, ProviderSettingsInput } from "../../api";
import ProviderSettingsPage from "../models/ProviderSettingsPage";
import AgentDefaultsSettings from "./AgentDefaultsSettings";
import AgentRulesSettings from "./AgentRulesSettings";

const ProjectMemoryPanel = lazy(() => import("../ProjectMemoryPanel"));

export type SettingsSection = "general" | "providers" | "rules" | "memory";

type Props = {
  section: SettingsSection;
  modelDefaults: ModelSelectionDefaults | null;
  providerSettings: ProviderSettings[];
  catalog: ModelCatalogResponse | null;
  projectRules: ProjectRulesResponse | null;
  workspaceRoot: string;
  loading: boolean;
  savingDefaults: boolean;
  onNavigate: (section: SettingsSection) => void;
  onBack: () => void;
  onSaveDefaults: (defaults: ModelSelectionDefaults) => Promise<void>;
  onSaveProvider: (input: ProviderSettingsInput) => Promise<void>;
  onCreateProvider: (input: CreateProviderInput) => Promise<ProviderSettings>;
  onRefreshProjectRules: () => Promise<void>;
};

const navigation: Array<{ id: SettingsSection; title: string; description: string }> = [
  { id: "general", title: "智能体默认值", description: "模式与默认模型" },
  { id: "providers", title: "模型 Provider", description: "连接、密钥与模型" },
  { id: "rules", title: "Agent Rules", description: "全局与项目规则" },
  { id: "memory", title: "Project Memory", description: "长期项目上下文" }
];

/** 统一承载所有智能体级配置，分类导航只更新浏览器历史路径。 */
export default function SettingsPage(props: Props) {
  return (
    <main className="settings-page">
      <aside className="settings-sidebar">
        <div className="settings-brand">
          <div><strong>智能体设置</strong><span>集中管理智能体行为与能力</span></div>
          <button type="button" onClick={props.onBack}>返回工作台</button>
        </div>
        <nav aria-label="设置分类">
          {navigation.map((item) => (
            <button key={item.id} type="button" className={props.section === item.id ? "active" : ""} onClick={() => props.onNavigate(item.id)}>
              <strong>{item.title}</strong>
              <span>{item.description}</span>
            </button>
          ))}
        </nav>
        <div className="settings-sidebar-note">
          <strong>配置即时生效</strong>
          <span>进行中的任务保留当前模式和模型，新默认值用于后续任务。</span>
        </div>
      </aside>

      <section className="settings-content">
        {props.section === "general" ? (
          <AgentDefaultsSettings defaults={props.modelDefaults} catalog={props.catalog} saving={props.savingDefaults} onSave={props.onSaveDefaults} />
        ) : null}
        {props.section === "providers" ? (
          <ProviderSettingsPage settings={props.providerSettings} catalog={props.catalog} loading={props.loading} onSave={props.onSaveProvider} onCreate={props.onCreateProvider} />
        ) : null}
        {props.section === "rules" ? (
          <AgentRulesSettings discoveredRules={props.projectRules} onRefreshDiscoveredRules={props.onRefreshProjectRules} />
        ) : null}
        {props.section === "memory" ? (
          <Suspense fallback={<div className="settings-page-loading" role="status">正在加载 Project Memory...</div>}>
            <ProjectMemoryPanel key={props.workspaceRoot} disabled={!props.workspaceRoot} workspaceRoot={props.workspaceRoot} />
          </Suspense>
        ) : null}
      </section>
    </main>
  );
}
