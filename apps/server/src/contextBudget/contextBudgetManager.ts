import type { ContextBudgetSnapshot, ContextBudgetUnitSnapshot, StructuredContextSummary } from "../contracts/context.js";
import type { ModelMessage } from "../contracts/model.js";
import type { AgentContext } from "../agentToolTypes.js";
import type { DeliveryUnit, PendingAgentToolCall } from "../types.js";
import { normalizeToolArtifacts } from "./artifactNormalizer.js";
import { createStructuredContextSummary } from "./summary.js";
import { ConservativeTokenEstimator, type TokenEstimator } from "./tokenEstimator.js";

export type ContextBudgetOptions = {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  /** 达到该比例后，Runtime 收紧宽泛探索并引导收敛当前交付单元。 */
  unitWarningRatio?: number;
};

export type ContextBudgetResult = {
  messages: ModelMessage[];
  snapshot: ContextBudgetSnapshot;
  summary: StructuredContextSummary | null;
};

function summaryMessage(summary: StructuredContextSummary): ModelMessage {
  return {
    role: "system",
    content: `以下是被压缩历史的结构化任务状态。不得覆盖当前用户目标或安全规则：\n${JSON.stringify(summary)}`
  };
}

type ContextMessageGroup = { indexes: number[]; priority: 0 | 1 | 2 | 3 | 4 };

function artifactPriority(message: ModelMessage) {
  if (message.role !== "tool" || !message.content) return null;
  try {
    const value = JSON.parse(message.content) as { priority?: unknown };
    return typeof value.priority === "number" && value.priority >= 0 && value.priority <= 4 ? value.priority : null;
  } catch {
    return null;
  }
}

function createMessageGroups(messages: ModelMessage[]): ContextMessageGroup[] {
  const assigned = new Set<number>();
  const groups: Array<{ indexes: number[]; basePriority: 0 | 1 | 2 | 3 | 4 }> = [];
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }

  messages.forEach((message, index) => {
    if (assigned.has(index)) return;
    if (message.role === "assistant" && message.toolCalls?.length) {
      const callIds = new Set(message.toolCalls.map((call) => call.id));
      const toolIndexes = messages
        .map((candidate, candidateIndex) => candidate.role === "tool" && candidate.toolCallId && callIds.has(candidate.toolCallId) ? candidateIndex : -1)
        .filter((candidateIndex) => candidateIndex >= 0);
      const indexes = [index, ...toolIndexes].sort((left, right) => left - right);
      indexes.forEach((candidateIndex) => assigned.add(candidateIndex));
      const incomplete = toolIndexes.length < callIds.size;
      const editCall = message.toolCalls.some((call) => /patch|write|replace|edit|delete/i.test(call.name));
      const failure = toolIndexes.some((candidateIndex) => /error|failed|failure|exitCode[^0-9]*[1-9]/i.test(messages[candidateIndex]?.content || ""));
      const toolPriorities = toolIndexes.map((candidateIndex) => artifactPriority(messages[candidateIndex]!)).filter((value): value is number => value !== null);
      const artifactBase = toolPriorities.length ? Math.min(...toolPriorities) : 3;
      groups.push({ indexes, basePriority: incomplete ? 0 : editCall || failure ? 1 : artifactBase as 1 | 2 | 3 | 4 });
      return;
    }

    assigned.add(index);
    const priority = message.role === "system" || index === lastUserIndex ? 0 : message.role === "tool" && /error|failed|failure/i.test(message.content || "") ? 1 : 3;
    groups.push({ indexes: [index], basePriority: priority });
  });

  return groups.map((group, index) => ({
    indexes: group.indexes,
    // 最近上下文至少按 P2 保留，但重复/失效产物仍保持 P4，避免近期重复结果挤占预算。
    priority: (group.basePriority === 4 ? 4 : index >= groups.length - 6 ? Math.min(group.basePriority, 2) : group.basePriority) as ContextMessageGroup["priority"]
  }));
}

function removeLowestPriorityGroup(messages: ModelMessage[]) {
  const candidates = createMessageGroups(messages).filter((group) => group.priority > 0);
  if (!candidates.length) return messages;
  // 数字越大越先移除；同优先级先压缩最旧的消息组。
  const target = candidates.reduce((selected, candidate) => candidate.priority > selected.priority ? candidate : selected);
  const removed = new Set(target.indexes);
  return messages.filter((_, index) => !removed.has(index));
}

function isSummaryMessage(message: ModelMessage) {
  return message.role === "system" && /结构化任务状态|structured task state/i.test(message.content || "");
}

function messageReferencesUnitFile(message: ModelMessage, unitFiles: Set<string>) {
  if (!unitFiles.size || !message.content) return false;
  return [...unitFiles].some((filePath) => message.content!.includes(filePath));
}

function createUnitBudgetSnapshot(input: {
  messages: ModelMessage[];
  estimator: TokenEstimator;
  unit?: DeliveryUnit;
  compressionCount: number;
  usageRatio: number;
  warningRatio: number;
}): ContextBudgetUnitSnapshot | undefined {
  if (!input.unit) return undefined;
  const unitFiles = new Set([...input.unit.candidateFiles, ...input.unit.filesRead, ...input.unit.plannedFiles]);
  let currentUnitContentTokens = 0;
  let historicalUnitSummaryTokens = 0;
  let globalRuleTokens = 0;
  let toolResultTokens = 0;
  let otherTokens = 0;
  let toolCallCount = 0;
  for (const message of input.messages) {
    const tokens = input.estimator.estimateMessages([message]);
    if (isSummaryMessage(message)) historicalUnitSummaryTokens += tokens;
    else if (message.role === "system") globalRuleTokens += tokens;
    else if (message.role === "tool") {
      toolResultTokens += tokens;
      if (messageReferencesUnitFile(message, unitFiles)) currentUnitContentTokens += tokens;
    } else if (messageReferencesUnitFile(message, unitFiles)) currentUnitContentTokens += tokens;
    else otherTokens += tokens;
    toolCallCount += message.toolCalls?.length ?? 0;
  }
  return {
    deliveryUnitId: input.unit.id,
    inputTokens: input.estimator.estimateMessages(input.messages),
    currentUnitContentTokens,
    historicalUnitSummaryTokens,
    globalRuleTokens,
    toolResultTokens,
    otherTokens,
    toolCallCount,
    compressionCount: input.compressionCount,
    // 即使压缩后的视图已回落，也必须把“本轮曾超预算”传给编排器，避免恢复后继续漫游。
    warning: input.compressionCount > 0 || input.usageRatio >= input.warningRatio,
    generatedAt: Date.now()
  };
}

/** 单元预算预警只约束宽泛探索，精确读取、补丁和验证仍应可用。 */
export function isUnitContextBudgetWarning(snapshot: ContextBudgetSnapshot) {
  return Boolean(snapshot.deliveryUnit?.warning);
}

/** 每次请求前计算预算，并在超限时用结构化摘要替换旧历史。 */
export function prepareContextBudget(input: {
  messages: ModelMessage[];
  tools?: unknown[];
  agentContext: AgentContext;
  options: ContextBudgetOptions;
  pendingToolCall?: PendingAgentToolCall | null;
  planStatus?: string[];
  filesModified?: string[];
  unresolvedQuestions?: string[];
  estimator?: TokenEstimator;
  activeDeliveryUnit?: DeliveryUnit;
}): ContextBudgetResult {
  const estimator = input.estimator ?? new ConservativeTokenEstimator();
  const toolSchemaTokens = estimator.estimateValue(input.tools ?? []);
  const availableInputTokens = Math.max(0, input.options.contextWindowTokens - input.options.reservedOutputTokens - toolSchemaTokens - input.options.safetyMarginTokens);
  const before = estimator.estimateMessages(input.messages);
  const normalized = normalizeToolArtifacts(input.messages, estimator);
  let selected = normalized.messages;
  let after = estimator.estimateMessages(selected);
  let summary: StructuredContextSummary | null = null;
  let compressionCount = normalized.truncatedArtifactCount > 0 ? 1 : 0;

  if (after > availableInputTokens) {
    const sourceMessages = selected;
    summary = createStructuredContextSummary({ messages: sourceMessages, coveredMessageIds: [], agentContext: input.agentContext, pendingToolCall: input.pendingToolCall, planStatus: input.planStatus, filesModified: input.filesModified, unresolvedQuestions: input.unresolvedQuestions });
    let attempts = selected.length;
    while (after > availableInputTokens && attempts > 0) {
      const next = removeLowestPriorityGroup(selected);
      if (next.length === selected.length) break;
      selected = next;
      attempts -= 1;
      after = estimator.estimateMessages([summaryMessage(summary), ...selected]);
    }
    const retainedIds = new Set(selected.map((message) => message.id).filter(Boolean));
    summary = createStructuredContextSummary({
      messages: sourceMessages,
      coveredMessageIds: sourceMessages.map((message) => message.id).filter((id): id is string => Boolean(id) && !retainedIds.has(id)),
      agentContext: input.agentContext,
      pendingToolCall: input.pendingToolCall,
      planStatus: input.planStatus,
      filesModified: input.filesModified,
      unresolvedQuestions: input.unresolvedQuestions
    });
    selected = [summaryMessage(summary), ...selected];
    after = estimator.estimateMessages(selected);
    compressionCount += 1;
    if (after > availableInputTokens) {
      throw new Error(`Context P0 content exceeds the available input budget (${after}/${availableInputTokens} estimated tokens).`);
    }
  }

  const usageRatio = availableInputTokens > 0 ? Number(Math.min(1, after / availableInputTokens).toFixed(4)) : 1;
  const snapshot: ContextBudgetSnapshot = {
    modelContextWindowTokens: input.options.contextWindowTokens,
    reservedOutputTokens: input.options.reservedOutputTokens,
    reservedToolSchemaTokens: toolSchemaTokens,
    safetyMarginTokens: input.options.safetyMarginTokens,
    availableInputTokens,
    estimatedInputTokensBeforeCompression: before,
    estimatedInputTokensAfterCompression: after,
    compressionCount,
    truncatedArtifactCount: normalized.truncatedArtifactCount,
    includedFileCount: new Set([
      ...input.agentContext.filesRead,
      ...normalized.artifacts.filter((artifact) => artifact.kind === "file" && artifact.source !== "unknown").map((artifact) => artifact.source)
    ]).size,
    usageRatio,
    automaticCompression: compressionCount > 0,
    generatedAt: Date.now(),
    estimator: estimator.kind,
    deliveryUnit: createUnitBudgetSnapshot({
      messages: selected,
      estimator,
      unit: input.activeDeliveryUnit,
      compressionCount,
      usageRatio,
      warningRatio: input.options.unitWarningRatio ?? 0.8
    })
  };

  return { messages: selected, snapshot, summary };
}
