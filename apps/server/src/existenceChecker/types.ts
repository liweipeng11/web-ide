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

/** 单个候选位置及其来源说明。 */
export type ExistenceCandidate = {
  path: string;
  detail: string;
};

/** 单个引用的检查结果。 */
export type ExistenceCheckResult = {
  target: ExistenceCheckTarget;
  status: ExistenceStatus;
  candidates: ExistenceCandidate[];
  reason: string;
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
