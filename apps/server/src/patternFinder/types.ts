/** 相似实现检索器的查询条件。 */
export type PatternFinderInput = {
  /** 当前任务描述，用于提取领域和职责关键词。 */
  taskDescription: string;
  /** 可选目标文件路径；即使文件尚未创建也可用于推断目录语义。 */
  targetPath?: string;
  /** 可选职责标签，例如 service、route、component 或 test。 */
  targetResponsibility?: string;
  /** 返回数量，服务端会限制为 1 到 3 个。 */
  limit?: number;
};

/** 单个候选文件的可复用实现特征。 */
export type PatternCandidate = {
  filePath: string;
  score: number;
  reasons: string[];
  reusableElements: string[];
  relatedTests: string[];
};

/** 相似实现检索结果。 */
export type PatternFinderResult = {
  query: Required<Pick<PatternFinderInput, "taskDescription">> & Omit<PatternFinderInput, "taskDescription">;
  candidates: PatternCandidate[];
  indexedFileCount: number;
  /** 未检索到足够相关的模式时给出的明确降级说明。 */
  noMatchReason?: string;
};
