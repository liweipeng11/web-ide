/** 检查器支持的引用对象类型。 */
export type ExistenceCheckKind = "import" | "symbol" | "script" | "environment" | "directory";

/** 单个待确认的项目引用。 */
export type ExistenceCheckTarget = {
  kind: ExistenceCheckKind;
  value: string;
  /** import 的发起文件，或 script 所属的 package.json 路径。 */
  fromPath?: string;
  /** 环境变量加载模式；未提供时按通用 .env 优先级解析。 */
  environmentMode?: string;
};

/** 检查结论：唯一存在、缺失或存在多个候选。 */
export type ExistenceStatus = "exists" | "missing" | "ambiguous";

/** 引用解析的结构化状态；planned_create 将在阶段 2 接入虚拟文件图。 */
export type ReferenceResolutionStatus =
  | "existing"
  | "planned_create"
  | "dependency_declared"
  | "dependency_installed"
  | "truly_missing"
  | "ambiguous"
  | "unknown";

/** 单个候选位置及其来源说明。 */
export type ExistenceCandidate = {
  path: string;
  detail: string;
};

/** 新引用解析结果，保留足够信息供后续工作流按风险决策。 */
export type ReferenceResolution = {
  status: ReferenceResolutionStatus;
  blocking: boolean;
  reason: string;
  candidates: ExistenceCandidate[];
  packageRoot?: string;
  resolvedPath?: string;
};

/** 单个引用的检查结果。 */
export type ExistenceCheckResult = {
  target: ExistenceCheckTarget;
  /** 兼容旧工作流的三态字段，阶段 1 暂不改变门禁行为。 */
  status: ExistenceStatus;
  candidates: ExistenceCandidate[];
  reason: string;
  /** 新工作流应消费此结构化结果。 */
  resolution: ReferenceResolution;
};

/** 批量存在性检查结果。 */
export type ExistenceCheckerResult = {
  checks: ExistenceCheckResult[];
  summary: {
    exists: number;
    missing: number;
    ambiguous: number;
  };
};

/** 从代码文本中提取出的 import 引用，供补丁和直接编辑执行前复核。 */
export type ImportReference = {
  specifier: string;
  symbols: string[];
};
