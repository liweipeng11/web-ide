import type { ImpactAnalysisOptions, ImpactAnalysisResult, ImpactChangeTarget } from "../impactAnalyzer/index.js";
import type { PlannedChange, SafeEditEvidence, StructuredModificationPlan } from "./types.js";

export const IMPACT_ANALYSIS_FRESHNESS_MS = 5 * 60 * 1000;

export type ImpactPreflightReason =
  | "destructive_change"
  | "multiple_existing_files"
  | "shared_symbol"
  | "boundary_file"
  | "cross_package"
  | "fresh_analysis"
  | "create_only"
  | "local_single_file";

export type ImpactPreflightDecision = {
  strategy: "analyze" | "reuse" | "skip";
  required: boolean;
  reasons: ImpactPreflightReason[];
  targets: ImpactChangeTarget[];
  reusedAnalysis?: ImpactAnalysisResult;
};

export type ExecuteImpactPreflightInput = {
  workspaceRoot: string;
  plan: StructuredModificationPlan;
  previousAnalyses?: ImpactAnalysisResult[];
  now?: number;
  freshnessMs?: number;
  analysisOptions?: ImpactAnalysisOptions;
  executeAnalysis: (
    workspaceRoot: string,
    targets: ImpactChangeTarget[],
    options?: ImpactAnalysisOptions
  ) => Promise<ImpactAnalysisResult>;
};

export type ImpactPreflightResult = {
  decision: ImpactPreflightDecision;
  analysis: ImpactAnalysisResult | null;
  evidence: SafeEditEvidence;
};

const disruptiveKinds = new Set(["delete", "rename", "signature"]);
const boundaryPathPattern = /(^|\/)(main|index|entry|bootstrap|routes?|router|config(?:uration)?|settings?)(\.[^/]+)?$|\/(routes?|router|config|configuration)\/|(^|\/)(package\.json|tsconfig(?:\.[^/]+)?\.json|[^/]+\.config\.[^/]+)$/i;
const sharedReasonPattern = /公共|共享|导出|接口|契约|路由|配置|入口|public|shared|export|api|contract|route|config|entry/i;

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function toImpactTarget(change: PlannedChange): ImpactChangeTarget {
  return {
    filePath: normalizePath(change.filePath),
    ...(change.symbolName ? { symbolName: change.symbolName } : {}),
    changeKind: change.changeKind === "create" ? "add" : change.changeKind
  };
}

function targetKey(target: ImpactChangeTarget) {
  return `${normalizePath(target.filePath).toLowerCase()}#${(target.symbolName || "").toLowerCase()}#${target.changeKind || "modify"}`;
}

function analysisMatchesTargets(analysis: ImpactAnalysisResult, targets: ImpactChangeTarget[]) {
  if (!analysis.complete || analysis.truncated || analysis.changes.length !== targets.length) return false;
  const expected = new Set(targets.map(targetKey));
  return analysis.changes.every((change) => change.status === "resolved" && expected.has(targetKey(change)));
}

function packageScope(filePath: string) {
  const parts = normalizePath(filePath).split("/");
  if (parts.length >= 2 && ["apps", "packages", "libs", "services"].includes(parts[0].toLowerCase())) {
    return `${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
  }
  return parts[0]?.toLowerCase() || ".";
}

/** 根据结构化计划决定是否需要分析；create 目标不会进入静态符号分析。 */
export function decideImpactPreflight(
  plan: Pick<StructuredModificationPlan, "files">,
  previousAnalyses: ImpactAnalysisResult[] = [],
  options: { now?: number; freshnessMs?: number } = {}
): ImpactPreflightDecision {
  const existingChanges = plan.files.filter((change) => change.changeKind !== "create");
  const targets = existingChanges.map(toImpactTarget);
  const reasons: ImpactPreflightReason[] = [];

  if (!targets.length) {
    return { strategy: "skip", required: false, reasons: ["create_only"], targets };
  }

  if (existingChanges.some((change) => disruptiveKinds.has(change.changeKind))) reasons.push("destructive_change");
  if (existingChanges.length >= 2) reasons.push("multiple_existing_files");
  if (existingChanges.some((change) => Boolean(change.symbolName) && sharedReasonPattern.test(change.reason))) reasons.push("shared_symbol");
  if (existingChanges.some((change) => boundaryPathPattern.test(normalizePath(change.filePath)))) reasons.push("boundary_file");
  if (new Set(existingChanges.map((change) => packageScope(change.filePath))).size >= 2) reasons.push("cross_package");

  const required = reasons.length > 0;
  if (!required) return { strategy: "skip", required: false, reasons: ["local_single_file"], targets };

  const now = options.now ?? Date.now();
  const freshnessMs = options.freshnessMs ?? IMPACT_ANALYSIS_FRESHNESS_MS;
  const reusable = [...previousAnalyses].reverse().find((analysis) =>
    typeof analysis.analyzedAt === "number"
    && now - analysis.analyzedAt >= 0
    && now - analysis.analyzedAt <= freshnessMs
    && analysisMatchesTargets(analysis, targets)
  );
  if (reusable) {
    return { strategy: "reuse", required: true, reasons: [...reasons, "fresh_analysis"], targets, reusedAnalysis: reusable };
  }
  return { strategy: "analyze", required: true, reasons, targets };
}

/** 执行动态预检，并把计划、虚拟创建图与影响分析合并为 Safe Editor 证据。 */
export async function executeImpactPreflight(input: ExecuteImpactPreflightInput): Promise<ImpactPreflightResult> {
  const decision = decideImpactPreflight(input.plan, input.previousAnalyses, {
    now: input.now,
    freshnessMs: input.freshnessMs
  });
  const analysis = decision.strategy === "analyze"
    ? await input.executeAnalysis(input.workspaceRoot, decision.targets, input.analysisOptions)
    : decision.reusedAnalysis || null;
  const hasCreateTargets = input.plan.files.some((change) => change.changeKind === "create");
  const diagnostics = [...new Set(analysis?.diagnostics || [])];

  return {
    decision,
    analysis,
    evidence: {
      sources: [
        "agent_plan",
        ...(hasCreateTargets ? ["planned_file_graph" as const] : []),
        ...(analysis ? ["impact_analysis" as const] : [])
      ],
      complete: analysis ? analysis.complete : true,
      diagnostics
    }
  };
}
