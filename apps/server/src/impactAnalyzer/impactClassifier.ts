import path from "node:path";
import type { SymbolDefinition } from "../symbolGraph/index.js";
import type { ImpactAnalysisResult, ImpactCategory, ImpactRisk, ImpactTargetResolution, TraversalImpact } from "./types.js";

const TEST_PATTERN = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.]+$/i;
const ROUTE_PATTERN = /(^|\/)(routes?|routers?|controllers?)(\/|$)|(?:route|router|controller)\.[^.]+$/i;
const CONFIG_PATTERN = /(^|\/)(config|configs)(\/|$)|(^|\/)[^/]*(config|rc)\.[^.]+$/i;
const ENTRY_PATTERN = /(^|\/)(index|main|server|app)\.[^.]+$/i;
const TYPE_PATTERN = /(^|\/)(types?|schemas?|models?)(\/|$)|\.d\.ts$/i;

/** 根据路径职责标记影响边界，供风险评估与验证范围选择使用。 */
export function classifyImpactFile(filePath: string): ImpactCategory[] {
  const normalized = filePath.split(path.sep).join("/");
  const categories: ImpactCategory[] = [];
  if (TEST_PATTERN.test(normalized)) categories.push("test");
  if (ROUTE_PATTERN.test(normalized)) categories.push("route");
  if (CONFIG_PATTERN.test(normalized)) categories.push("configuration");
  if (ENTRY_PATTERN.test(normalized)) categories.push("entrypoint");
  if (TYPE_PATTERN.test(normalized)) categories.push("type_contract");
  if (!categories.length) categories.push("implementation");
  return categories;
}

export function attachImpactMetadata(impacts: TraversalImpact[], symbols: SymbolDefinition[]) {
  const symbolMap = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  return impacts
    .map((impact) => ({
      filePath: impact.filePath,
      depth: impact.depth,
      impact: impact.depth === 1 ? "direct" as const : "indirect" as const,
      categories: classifyImpactFile(impact.filePath),
      reasons: impact.reasons,
      affectedSymbols: [...impact.affectedSymbolIds].map((id) => symbolMap.get(id)).filter((symbol): symbol is SymbolDefinition => Boolean(symbol))
    }))
    .sort((left, right) => left.depth - right.depth || left.filePath.localeCompare(right.filePath));
}

/** 将破坏性变更、影响扇出和关键边界汇总成可解释的风险等级。 */
export function assessImpactRisk(changes: ImpactTargetResolution[], impactedFiles: ImpactAnalysisResult["impactedFiles"], diagnostics: string[]): ImpactRisk {
  let score = 0;
  const factors: string[] = [];
  const destructive = changes.filter((change) => change.changeKind === "delete" || change.changeKind === "rename" || change.changeKind === "signature");
  if (destructive.length) {
    score += 4;
    factors.push("包含删除、重命名或签名变更");
  }
  if (impactedFiles.length >= 10) {
    score += 3;
    factors.push(`影响文件较多（${impactedFiles.length} 个）`);
  } else if (impactedFiles.length >= 3) {
    score += 2;
    factors.push(`影响多个文件（${impactedFiles.length} 个）`);
  }
  const boundaryCount = impactedFiles.filter((file) => file.categories.some((category) => ["route", "entrypoint", "configuration", "type_contract"].includes(category))).length;
  if (boundaryCount) {
    score += 2;
    factors.push(`触及 ${boundaryCount} 个路由、入口、配置或类型边界文件`);
  }
  if (diagnostics.length) {
    score += 2;
    factors.push("分析存在不完整或目标解析诊断");
  }
  if (!factors.length) factors.push("影响范围局限且未发现破坏性变更");
  return { level: score >= 6 ? "high" : score >= 3 ? "medium" : "low", score: Math.min(score, 10), factors };
}
