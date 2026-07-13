import type { ContextSelectionInput, EvidenceRecord, RequiredCompanionFile } from "./types.js";

type CompanionRule = {
  id: string;
  reason: string;
  matches: (input: ContextSelectionInput, evidence: EvidenceRecord[]) => boolean;
  companionHints: (input: ContextSelectionInput) => string[];
};

function normalizeFilePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
}

function unique(values: string[]) {
  return [...new Set(values.map(normalizeFilePath).filter(Boolean))];
}

function lowerIncludesAny(value: string, keywords: string[]) {
  const normalized = value.toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function goalOrEvidenceMatches(input: ContextSelectionInput, evidence: EvidenceRecord[], keywords: string[]) {
  const evidenceText = evidence.map((item) => `${item.filePath} ${item.detail}`).join("\n");
  return lowerIncludesAny(`${input.userGoal}\n${evidenceText}`, keywords);
}

function companionStatus(filePath: string, readFileSet: Set<string>): RequiredCompanionFile["status"] {
  // 规则第一期只给出“应继续定位的方向”，当本轮已读多个上下文文件时视为已完成伴随检查。
  if (filePath.startsWith("待定位:")) return readFileSet.size >= 2 ? "read" : "missing";
  return readFileSet.has(filePath.toLowerCase()) ? "read" : "pending";
}

const companionRules: CompanionRule[] = [
  {
    id: "type-contract-change",
    reason: "命中类型、接口或 schema 相关变更，需要检查引用方或请求响应层是否同步。",
    matches: (input, evidence) => goalOrEvidenceMatches(input, evidence, ["types.ts", "interface", "type ", " schema", "schema", "类型", "接口定义"]),
    companionHints: () => ["待定位:type-consumers-or-request-layer"]
  },
  {
    id: "api-service-change",
    reason: "命中 API、service 或 request 相关变更，需要检查调用组件、hook 或 controller。",
    matches: (input, evidence) => goalOrEvidenceMatches(input, evidence, ["api.ts", "service", "request", "接口", "字段", "返回", "请求"]),
    companionHints: () => ["待定位:api-consumers-hooks-or-controllers"]
  },
  {
    id: "react-props-state-change",
    reason: "命中 React props 或状态字段变更，需要检查父组件、类型定义和相关 hook。",
    matches: (input, evidence) => goalOrEvidenceMatches(input, evidence, ["props", "prop ", "state", "hook", "组件", "父组件", "改名"]),
    companionHints: () => ["待定位:parent-components-types-or-hooks"]
  },
  {
    id: "route-entry-change",
    reason: "命中路由或页面入口变更，需要检查路由注册、导航入口和页面依赖组件。",
    matches: (input, evidence) => goalOrEvidenceMatches(input, evidence, ["route", "router", "routes", "page", "页面", "路由", "导航"]),
    companionHints: () => ["待定位:route-registration-navigation-or-page-dependencies"]
  },
  {
    id: "validation-failure-fix",
    reason: "命中验证失败后的修复，需要检查失败输出直接涉及的文件和最近 patch 文件。",
    matches: (input) => Boolean(input.previousFailureFiles?.length) || lowerIncludesAny(input.userGoal, ["验证失败", "test failed", "typecheck", "build failed"]),
    companionHints: (input) => input.previousFailureFiles || ["待定位:validation-failure-files"]
  }
];

export function inferRequiredCompanionFiles(input: ContextSelectionInput, evidence: EvidenceRecord[]): RequiredCompanionFile[] {
  const readFileSet = new Set((input.filesRead || []).map((filePath) => normalizeFilePath(filePath).toLowerCase()));
  const companions: RequiredCompanionFile[] = [];

  for (const rule of companionRules) {
    if (!rule.matches(input, evidence)) continue;

    for (const filePath of unique(rule.companionHints(input))) {
      companions.push({
        filePath,
        reason: rule.reason,
        requiredBy: rule.id,
        status: companionStatus(filePath, readFileSet)
      });
    }
  }

  const latestByPath = new Map<string, RequiredCompanionFile>();

  for (const companion of companions) {
    const previous = latestByPath.get(companion.filePath);

    if (!previous || previous.status !== "read") {
      latestByPath.set(companion.filePath, companion);
    }
  }

  return [...latestByPath.values()];
}
