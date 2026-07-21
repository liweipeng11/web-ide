import type { MemoryRetrievalContext, ProjectMemoryItem, ScoredProjectMemoryItem } from "./types.js";

const genericTerms = new Set(["the", "and", "for", "with", "from", "this", "that", "file", "task", "实现", "功能", "项目", "代码", "优化", "检查", "修改"]);

function normalizeText(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/\\/g, "/");
}

function tokenize(value: string) {
  const terms = (normalizeText(value).match(/[\p{L}\p{N}_-]{2,}/gu) || []).flatMap((term) => {
    if (!/\p{Script=Han}/u.test(term) || term.length <= 2) return [term];
    // 中文没有空格分词，补充二元片段以覆盖“实现认证功能”与“认证使用 JWT”的交集。
    return [term, ...Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))];
  });
  return [...new Set(terms)].filter((term) => !genericTerms.has(term));
}

function normalizePath(value: string) {
  return normalizeText(value).replace(/^\.\//, "").replace(/\/+$/, "");
}

function pathsOverlap(left: string, right: string) {
  const a = normalizePath(left);
  const b = normalizePath(right);
  return Boolean(a && b && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function lexicalMatches(query: string, candidate: string) {
  const candidateText = normalizeText(candidate);
  return tokenize(query).filter((term) => candidateText.includes(term));
}

/** 确定性评分只依赖输入上下文和记忆字段，不使用随机数或数组原始顺序。 */
export function scoreProjectMemoryItem(item: ProjectMemoryItem, context: MemoryRetrievalContext, now = Date.now()): ScoredProjectMemoryItem | null {
  const reasons: string[] = [];
  let relevanceScore = 0;
  const searchable = [item.content, ...item.scope.paths, ...item.sourceRefs.map((ref) => ref.value)].join(" ");
  const requestMatches = lexicalMatches(context.userRequest, searchable);
  if (requestMatches.length) {
    relevanceScore += Math.min(36, requestMatches.length * 12);
    reasons.push(`request:${requestMatches.sort().join(",")}`);
  }

  const requestedPaths = [...context.contextPaths, ...context.plannedFiles];
  const matchingPaths = item.scope.paths.filter((scopePath) => requestedPaths.some((requestPath) => pathsOverlap(scopePath, requestPath)));
  if (matchingPaths.length) {
    relevanceScore += 40;
    reasons.push(`path:${matchingPaths.map(normalizePath).sort().join(",")}`);
  } else if (item.scope.type === "path") {
    // 路径记忆在作用域外不能仅靠时间或类型权重进入 Prompt。
    return null;
  }

  const technologies = [...context.languages, ...context.frameworks];
  const technologyMatches = technologies.filter((technology) => lexicalMatches(technology, searchable).length > 0);
  if (technologyMatches.length) {
    relevanceScore += Math.min(24, technologyMatches.length * 12);
    reasons.push(`technology:${technologyMatches.map(normalizeText).sort().join(",")}`);
  }

  if (context.branch) {
    const branchMatches = item.sourceRefs.some((ref) => normalizeText(ref.value) === normalizeText(context.branch!)) || normalizeText(item.content).includes(normalizeText(context.branch));
    if (branchMatches) {
      relevanceScore += 18;
      reasons.push("branch");
    }
  }

  // 没有任何任务相关信号的全局记忆不参与召回，避免“最新但无关”挤占预算。
  if (relevanceScore === 0) return null;

  const kindWeight = { risk: 12, decision: 10, convention: 7, fact: 5 }[item.kind];
  const sourceWeight = { user: 6, system: 3, migration: 1 }[item.createdBy];
  const statusWeight = item.status === "active" ? 8 : -8;
  const confidenceWeight = Math.round(Math.max(0, Math.min(1, item.confidence)) * 8);
  const ageDays = Math.max(0, (now - item.updatedAt) / 86_400_000);
  const recencyWeight = Math.max(-12, 5 - Math.floor(ageDays / 30));
  const score = relevanceScore + kindWeight + sourceWeight + statusWeight + confidenceWeight + recencyWeight;
  reasons.push(`kind:${item.kind}`, `source:${item.createdBy}`, `status:${item.status}`);
  return { item, score, reasons };
}

export function rankProjectMemoryItems(items: ProjectMemoryItem[], context: MemoryRetrievalContext, now = Date.now()) {
  return items
    .map((item) => scoreProjectMemoryItem(item, context, now))
    .filter((item): item is ScoredProjectMemoryItem => item !== null)
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt || left.item.id.localeCompare(right.item.id))
    .slice(0, Math.max(0, context.maxItems));
}
