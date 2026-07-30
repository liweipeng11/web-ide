import type { SafeEditEvidenceSource, SafeEditFileRole, SafeEditReport, SafeEditRisk, SafeEditStatus } from "../api.js";

export type SafeEditFileViewModel = {
  filePath: string;
  role: SafeEditFileRole;
  roleLabel: string;
  reasons: string[];
  risks: SafeEditRisk[];
};

export type SafeEditViewModel = {
  status: SafeEditStatus;
  title: string;
  description: string;
  canApply: boolean;
  requiresApproval: boolean;
  evidenceLabels: string[];
  evidenceComplete: boolean;
  diagnostics: string[];
  files: SafeEditFileViewModel[];
  expansionFiles: string[];
};

const statusContent: Record<SafeEditStatus, { title: string; description: string }> = {
  clean: { title: "修改范围正常", description: "当前修改具备完整范围证据，可以正常审核和应用。" },
  warning: { title: "存在需要审查的修改", description: "请检查下方文件说明和风险提示后再决定是否应用。" },
  needs_analysis: { title: "缺少修改范围证据", description: "系统需要先补充影响分析，当前补丁暂未允许应用。" },
  high_risk: { title: "检测到确认的范围扩散", description: "以下修改超出已确认范围，仅可在结构化审批后显式应用。" }
};

const roleLabels: Record<SafeEditFileRole, string> = {
  required: "必要改动",
  supporting: "配套改动",
  validation_only: "仅建议验证",
  unverified: "范围待分析",
  expansion: "计划外扩散"
};

const evidenceLabels: Record<SafeEditEvidenceSource, string> = {
  explicit_target: "明确目标文件",
  agent_plan: "结构化修改计划",
  impact_analysis: "影响分析",
  planned_file_graph: "计划文件关系"
};

function dedupeRisks(risks: SafeEditRisk[]) {
  const seen = new Set<string>();
  return risks.filter((risk) => {
    const key = `${risk.kind}:${risk.level}:${risk.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizePath(filePath: string) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

/** 将服务端报告转换为文件级展示模型，避免同一风险在摘要和文件列表中重复出现。 */
export function createSafeEditViewModel(report: SafeEditReport, targetPaths?: string[]): SafeEditViewModel {
  const targetSet = targetPaths?.length ? new Set(targetPaths.map(normalizePath)) : null;
  const reportRisks = report.risks.filter((risk) => !targetSet || targetSet.has(normalizePath(risk.filePath)));
  const assessments = report.files.filter((file) => !targetSet || targetSet.has(normalizePath(file.filePath)));
  const filesByPath = new Map<string, SafeEditFileViewModel>();

  for (const assessment of assessments) {
    const key = normalizePath(assessment.filePath);
    filesByPath.set(key, {
      filePath: assessment.filePath,
      role: assessment.role,
      roleLabel: roleLabels[assessment.role],
      reasons: [...new Set(assessment.reasons)],
      risks: dedupeRisks([...assessment.risks, ...reportRisks.filter((risk) => normalizePath(risk.filePath) === key)])
    });
  }

  // 兼容旧报告中只存在顶层 risks、没有文件评估的情况。
  for (const risk of reportRisks) {
    const key = normalizePath(risk.filePath);
    if (!filesByPath.has(key)) {
      filesByPath.set(key, {
        filePath: risk.filePath,
        role: "unverified",
        roleLabel: roleLabels.unverified,
        reasons: [],
        risks: dedupeRisks(reportRisks.filter((item) => normalizePath(item.filePath) === key))
      });
    }
  }

  const risks = [...filesByPath.values()].flatMap((file) => file.risks);
  const hasEvidenceGap = risks.some((risk) => risk.kind === "missing_impact_analysis" || risk.kind === "incomplete_impact_analysis");
  const hasConfirmedHighRisk = risks.some((risk) => risk.level === "high" && risk.kind !== "missing_impact_analysis" && risk.kind !== "incomplete_impact_analysis");
  const status: SafeEditStatus = hasConfirmedHighRisk ? "high_risk" : hasEvidenceGap ? "needs_analysis" : risks.length ? "warning" : "clean";
  const evidence = report.recommendation.evidence;
  const sources = evidence?.sources?.length
    ? evidence.sources
    : report.recommendation.evidenceSource === "none"
      ? []
      : [report.recommendation.evidenceSource];

  return {
    status,
    ...statusContent[status],
    canApply: status !== "needs_analysis",
    requiresApproval: status === "high_risk",
    evidenceLabels: [...new Set(sources.map((source) => evidenceLabels[source]))],
    evidenceComplete: evidence?.complete ?? report.recommendation.impactAnalysisComplete === true,
    diagnostics: [...new Set([...(evidence?.diagnostics || []), ...report.recommendation.diagnostics])],
    files: [...filesByPath.values()],
    // 服务端历史字段可能同时包含 validation_only；“拒绝计划外文件”只作用于确认的 expansion。
    expansionFiles: [...new Set(
      [...filesByPath.values()]
        .filter((file) => file.role === "expansion")
        .map((file) => file.filePath)
    )]
  };
}
