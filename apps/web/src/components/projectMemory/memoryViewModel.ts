import type { ProjectMemoryItem } from "../../api";

export type MemoryFilters = {
  query: string;
  kind: "all" | ProjectMemoryItem["kind"];
  status: "all" | ProjectMemoryItem["status"];
  validation: "all" | ProjectMemoryItem["validationStatus"];
};

export const kindLabels: Record<ProjectMemoryItem["kind"], string> = {
  convention: "约定",
  decision: "决策",
  fact: "事实",
  risk: "风险"
};

export const statusLabels: Record<ProjectMemoryItem["status"], string> = {
  candidate: "待审核",
  active: "有效",
  stale: "可能过期",
  rejected: "已拒绝",
  superseded: "已替代",
  archived: "已归档"
};

export const validationLabels: Record<ProjectMemoryItem["validationStatus"], string> = {
  unverified: "未验证",
  valid: "来源有效",
  possibly_stale: "可能过期",
  invalid: "已失效",
  superseded: "已替代",
  archived: "已归档"
};

export function filterMemoryItems(items: ProjectMemoryItem[], filters: MemoryFilters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.kind !== "all" && item.kind !== filters.kind) return false;
    if (filters.status !== "all" && item.status !== filters.status) return false;
    if (filters.validation !== "all" && item.validationStatus !== filters.validation) return false;
    if (!query) return true;
    return [item.content, item.kind, item.status, ...item.scope.paths, ...item.sourceRefs.map((ref) => `${ref.type} ${ref.value}`)]
      .join(" ").toLocaleLowerCase().includes(query);
  });
}

export function formatMemoryTime(value?: number) {
  return value ? new Date(value).toLocaleString() : "暂无记录";
}

export function explainRetrievalReason(reason: string) {
  const [type, detail] = reason.split(":", 2);
  const labels: Record<string, string> = { request: "请求关键词", path: "路径作用域", technology: "技术栈", kind: "记忆类型", source: "创建来源", status: "生命周期", validation: "验证状态", branch: "当前分支" };
  return detail ? `${labels[type] || type}：${detail}` : labels[type] || reason;
}
