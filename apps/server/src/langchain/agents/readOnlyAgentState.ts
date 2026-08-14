export type ReadOnlyAgentStatus = "running" | "completed" | "failed" | "cancelled";

export type ReadOnlyToolCallRecord = {
  id: string;
  name: string;
};

export type ReadOnlyAgentState = {
  goal: string;
  status: ReadOnlyAgentStatus;
  stepCount: number;
  toolCallCount: number;
  readFileCount: number;
  maxSteps: number;
  maxToolCalls: number;
  maxReadFiles: number;
  toolCalls: ReadOnlyToolCallRecord[];
  facts: string[];
  evidence: string[];
  finalAnswer?: string;
  error?: string;
};

export type ReadOnlyAgentLimits = {
  maxSteps?: number;
  maxToolCalls?: number;
  maxReadFiles?: number;
};

const DEFAULT_LIMITS = {
  maxSteps: 8,
  maxToolCalls: 12,
  maxReadFiles: 20
} as const;

/** 创建不含文件正文、Prompt 或凭据的只读 Agent 状态。 */
export function createReadOnlyAgentState(goal: string, limits: ReadOnlyAgentLimits = {}): ReadOnlyAgentState {
  const normalizedGoal = goal.trim();
  if (!normalizedGoal) throw new Error("只读 Agent 目标不能为空。");

  return {
    goal: normalizedGoal,
    status: "running",
    stepCount: 0,
    toolCallCount: 0,
    readFileCount: 0,
    maxSteps: positiveInteger(limits.maxSteps, DEFAULT_LIMITS.maxSteps, "maxSteps"),
    maxToolCalls: positiveInteger(limits.maxToolCalls, DEFAULT_LIMITS.maxToolCalls, "maxToolCalls"),
    maxReadFiles: positiveInteger(limits.maxReadFiles, DEFAULT_LIMITS.maxReadFiles, "maxReadFiles"),
    toolCalls: [],
    facts: [],
    evidence: []
  };
}

/**
 * 以不可变方式合并一次只读进展；实际 Agent Loop 在 2B 中负责调用该函数。
 * 去重能避免恢复或重复工具调用把同一事实无限写入状态。
 */
export function advanceReadOnlyAgentState(
  state: Readonly<ReadOnlyAgentState>,
  update: {
    toolCall?: ReadOnlyToolCallRecord;
    readFiles?: number;
    facts?: readonly string[];
    evidence?: readonly string[];
  } = {}
): ReadOnlyAgentState {
  assertRunning(state);
  const stepCount = state.stepCount + 1;
  const toolCalls = update.toolCall ? uniqueToolCalls([...state.toolCalls, update.toolCall]) : [...state.toolCalls];
  const toolCallCount = state.toolCallCount + (update.toolCall ? 1 : 0);
  const readFileCount = state.readFileCount + nonNegativeInteger(update.readFiles ?? 0, "readFiles");

  if (stepCount > state.maxSteps) throw new Error(`只读 Agent 超出最大步骤数：${state.maxSteps}`);
  if (toolCallCount > state.maxToolCalls) throw new Error(`只读 Agent 超出最大工具调用数：${state.maxToolCalls}`);
  if (readFileCount > state.maxReadFiles) throw new Error(`只读 Agent 超出最大读取文件数：${state.maxReadFiles}`);

  return {
    ...state,
    stepCount,
    toolCallCount,
    readFileCount,
    toolCalls,
    facts: uniqueStrings([...state.facts, ...(update.facts ?? [])]),
    evidence: uniqueStrings([...state.evidence, ...(update.evidence ?? [])])
  };
}

export function finishReadOnlyAgentState(state: Readonly<ReadOnlyAgentState>, finalAnswer: string): ReadOnlyAgentState {
  assertRunning(state);
  const answer = finalAnswer.trim();
  if (!answer) throw new Error("只读 Agent 最终答案不能为空。");
  return { ...state, status: "completed", finalAnswer: answer };
}

export function failReadOnlyAgentState(
  state: Readonly<ReadOnlyAgentState>,
  status: Extract<ReadOnlyAgentStatus, "failed" | "cancelled">,
  error: string
): ReadOnlyAgentState {
  assertRunning(state);
  const message = error.trim();
  if (!message) throw new Error("只读 Agent 失败原因不能为空。");
  return { ...state, status, error: message };
}

function assertRunning(state: Readonly<ReadOnlyAgentState>): void {
  if (state.status !== "running") throw new Error(`只读 Agent 已处于终态：${state.status}`);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new Error(`${name} 必须是正整数。`);
  return resolved;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数。`);
  return value;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniqueToolCalls(values: readonly ReadOnlyToolCallRecord[]): ReadOnlyToolCallRecord[] {
  const seen = new Set<string>();
  return values.filter((call) => {
    const key = `${call.id}\u0000${call.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((call) => ({ ...call }));
}
