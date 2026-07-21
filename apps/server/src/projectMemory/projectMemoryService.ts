import { HttpError } from "../errors.js";
import { analyzeProject } from "../projectAnalyzer.js";
import { listTaskSessions } from "../taskSessionStore.js";
import type { TaskSession } from "../types.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { normalizeProjectMemory } from "./projectMemoryMigration.js";
import { readProjectMemory, writeProjectMemory } from "./projectMemoryStore.js";
import { PROJECT_MEMORY_SCHEMA_VERSION, type ProjectMemory, type ProjectMemoryTechStack, type UpdateProjectMemoryInput } from "./types.js";
import { buildProjectMemoryPrompt } from "./projectMemoryPrompt.js";
import { applyMemoryLifecycle } from "./memoryLifecycleService.js";
import { validateProjectMemory } from "./memoryValidationService.js";
import { recordMemoryValidationMetric } from "./memoryMetrics.js";
import { ensureMemoryContentIsSafe, findMemoryPromptInjectionReason, findSensitiveMemoryReason } from "./memorySanitizer.js";
import { isProjectMemoryFeatureEnabled } from "./projectMemoryFeatureFlags.js";

const memoryOperationQueues = new Map<string, Promise<unknown>>();

function requireWorkspaceRoot(workspaceRoot = getWorkspaceRoot()) {
  if (!workspaceRoot) throw new HttpError(400, "Open a workspace before accessing project memory");
  return workspaceRoot;
}

async function enqueueMemoryOperation<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const previous = memoryOperationQueues.get(workspaceRoot) || Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  memoryOperationQueues.set(workspaceRoot, next);

  try {
    return await next;
  } finally {
    if (memoryOperationQueues.get(workspaceRoot) === next) memoryOperationQueues.delete(workspaceRoot);
  }
}

function buildTechStack(analysis: Awaited<ReturnType<typeof analyzeProject>>): ProjectMemoryTechStack {
  return {
    packageManager: analysis.packageManager.name,
    languages: analysis.techStack.languages,
    frameworks: analysis.techStack.frameworks,
    buildTools: analysis.techStack.buildTools,
    lintTools: analysis.techStack.lintTools,
    typeSystems: analysis.techStack.typeSystems,
    testTools: analysis.testSystem.tools,
    workspacePackages: analysis.structure.workspacePackages,
    scannedAt: Date.now()
  };
}

function buildProjectSummary(techStack: ProjectMemoryTechStack) {
  const stack = [...techStack.languages, ...techStack.frameworks].join("、") || "未识别技术栈";
  const workspace = techStack.workspacePackages.length ? `，包含 ${techStack.workspacePackages.length} 个工作区包` : "";
  return `${techStack.packageManager || "未知包管理器"} 项目，主要技术栈为 ${stack}${workspace}。`;
}

async function createInitialMemory(workspaceRoot: string): Promise<ProjectMemory> {
  const analysis = await analyzeProject(workspaceRoot);
  const techStack = buildTechStack(analysis);
  const now = Date.now();

  return {
    schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
    snapshot: {
      projectSummary: buildProjectSummary(techStack),
      projectSummarySource: "generated",
      techStack,
      currentGoals: [],
      recentChanges: [],
      pendingItems: [],
      confirmedRisks: []
    },
    items: [],
    createdAt: now,
    updatedAt: now
  };
}

function getAppliedFiles(session: TaskSession) {
  const files = session.diffView?.appliedFiles?.length
    ? session.diffView.appliedFiles
    : session.filesChanged.length
      ? session.filesChanged
      : session.gitCommits?.flatMap((commit) => commit.files) || [];
  return [...new Set(files)].slice(0, 50);
}

/** 将任务事实投影为有上限的长期摘要，不保存完整聊天或工具输出。 */
export function synchronizeProjectMemoryWithTasks(memory: ProjectMemory, sessions: TaskSession[]): ProjectMemory {
  const ordered = [...sessions].sort((left, right) => right.updatedAt - left.updatedAt);
  const sessionChanges = ordered
    .map((session) => ({ session, files: getAppliedFiles(session) }))
    .filter(({ files }) => files.length > 0)
    // 不把任务目标中的凭据或伪造指令同步进长期 Snapshot。
    .filter(({ session }) => !findSensitiveMemoryReason(session.userGoal) && !findMemoryPromptInjectionReason(session.userGoal))
    .map(({ session, files }) => ({ taskSessionId: session.id, summary: session.userGoal, files, changedAt: session.updatedAt }));
  // 最近改动是长期事实：任务历史被清理后仍保留已同步摘要；同一任务的新事实覆盖旧快照。
  const recentChangesByTask = new Map(memory.snapshot.recentChanges.map((change) => [change.taskSessionId, change]));
  sessionChanges.forEach((change) => recentChangesByTask.set(change.taskSessionId, change));
  const recentChanges = [...recentChangesByTask.values()].sort((left, right) => right.changedAt - left.changedAt).slice(0, 20);
  const pendingItems = ordered
    .filter((session) => session.status !== "success" && session.status !== "cancelled")
    .filter((session) => !findSensitiveMemoryReason(session.userGoal) && !findMemoryPromptInjectionReason(session.userGoal))
    .map((session) => ({ taskSessionId: session.id, summary: session.userGoal, status: session.status, updatedAt: session.updatedAt }))
    .slice(0, 20);

  const unchanged = JSON.stringify(memory.snapshot.recentChanges) === JSON.stringify(recentChanges) && JSON.stringify(memory.snapshot.pendingItems) === JSON.stringify(pendingItems);
  if (unchanged) return memory;

  return normalizeProjectMemory({ ...memory, snapshot: { ...memory.snapshot, recentChanges, pendingItems }, updatedAt: Date.now() });
}

async function loadProjectMemory(options: { workspaceRoot: string; sessions?: TaskSession[]; syncTasks?: boolean }) {
  const workspaceRoot = options.workspaceRoot;
  let memory = (await readProjectMemory(workspaceRoot)) || (await createInitialMemory(workspaceRoot));

  if (options.syncTasks !== false) {
    const sessions = options.sessions || (await listTaskSessions({ includeDiffView: false }));
    const synchronized = synchronizeProjectMemoryWithTasks(memory, sessions);
    if (synchronized !== memory) memory = await writeProjectMemory(workspaceRoot, synchronized);
  }

  // 首次读取也必须落盘，确保下一次进程启动能直接恢复稳定画像。
  if (!(await readProjectMemory(workspaceRoot))) memory = await writeProjectMemory(workspaceRoot, memory);
  return memory;
}

export async function getProjectMemory(options: { workspaceRoot?: string; sessions?: TaskSession[]; syncTasks?: boolean } = {}) {
  const workspaceRoot = requireWorkspaceRoot(options.workspaceRoot);
  return enqueueMemoryOperation(workspaceRoot, () => loadProjectMemory({ ...options, workspaceRoot }));
}

export async function updateProjectMemory(input: UpdateProjectMemoryInput, workspaceRoot?: string) {
  [input.projectSummary, ...(input.currentGoals || []), ...(input.confirmedRisks || [])]
    .filter((value): value is string => value !== undefined)
    .forEach(ensureMemoryContentIsSafe);
  const root = requireWorkspaceRoot(workspaceRoot);
  return enqueueMemoryOperation(root, async () => {
    const current = await loadProjectMemory({ workspaceRoot: root });
    const next = normalizeProjectMemory({
      ...current,
      snapshot: {
        ...current.snapshot,
        ...input,
        projectSummarySource: input.projectSummary === undefined ? current.snapshot.projectSummarySource : "manual"
      },
      updatedAt: Date.now()
    });
    return writeProjectMemory(root, next);
  });
}

/** 在同一工作区队列内读改写，供候选记忆等子域安全更新 V3 数据。 */
export async function mutateProjectMemory(
  mutate: (memory: ProjectMemory) => ProjectMemory | Promise<ProjectMemory>,
  workspaceRoot?: string
) {
  const root = requireWorkspaceRoot(workspaceRoot);
  return enqueueMemoryOperation(root, async () => {
    const current = await loadProjectMemory({ workspaceRoot: root });
    const next = normalizeProjectMemory(await mutate(current));
    // 无变化时不刷新 updatedAt 或重写文件，验证缓存命中和使用时间节流依赖这一点。
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    return writeProjectMemory(root, { ...next, updatedAt: Date.now() });
  });
}

/** 召回前统一执行生命周期与来源验证；任何验证故障都只会降低可信度。 */
export async function prepareProjectMemoryForRetrieval(options: { workspaceRoot?: string; branch?: string } = {}) {
  const root = requireWorkspaceRoot(options.workspaceRoot);
  return enqueueMemoryOperation(root, async () => {
    const sessions = await listTaskSessions({ includeDiffView: false });
    const current = await loadProjectMemory({ workspaceRoot: root, sessions });
    const completed = sessions.filter((session) => session.status === "success");
    const lifecycle = applyMemoryLifecycle(current, {
      completedTaskSummaries: new Set(completed.map((session) => session.userGoal))
    });
    const validated = isProjectMemoryFeatureEnabled("validationEnabled")
      ? await validateProjectMemory(lifecycle, {
        workspaceRoot: root,
        currentBranch: options.branch,
        taskIds: sessions.length ? new Set(sessions.map((session) => session.id)) : undefined
      })
      : { memory: lifecycle, results: [] };
    if (isProjectMemoryFeatureEnabled("usageLogEnabled")) {
      recordMemoryValidationMetric(
        validated.results.filter((result) => result.status === "valid").length,
        validated.results.length,
        validated.memory
      );
    }
    const next = normalizeProjectMemory(validated.memory);
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    return writeProjectMemory(root, { ...next, updatedAt: Date.now() });
  });
}

/** 高频召回只按五分钟粒度记录使用时间，避免每次模型调用都触发磁盘写入。 */
export async function recordProjectMemoryUsage(itemIds: string[], workspaceRoot?: string, now = Date.now()) {
  if (!itemIds.length) return;
  const selected = new Set(itemIds);
  await mutateProjectMemory((memory) => ({
    ...memory,
    items: memory.items.map((item) => selected.has(item.id) && now - (item.lastUsedAt ?? 0) >= 5 * 60_000
      ? { ...item, lastUsedAt: now }
      : item)
  }), workspaceRoot);
}

export async function refreshProjectMemoryAnalysis(workspaceRoot?: string) {
  const root = requireWorkspaceRoot(workspaceRoot);
  return enqueueMemoryOperation(root, async () => {
    const current = await loadProjectMemory({ workspaceRoot: root });
    const techStack = buildTechStack(await analyzeProject(root));
    const previousGeneratedSummary = buildProjectSummary(current.snapshot.techStack);
    const shouldRefreshSummary = current.snapshot.projectSummarySource === "generated" || current.snapshot.projectSummary === previousGeneratedSummary;
    return writeProjectMemory(
      root,
      normalizeProjectMemory({
        ...current,
        // 旧版本通过内容比对识别自动摘要；明确手工维护的简介不会被重新扫描覆盖。
        snapshot: {
          ...current.snapshot,
          projectSummary: shouldRefreshSummary ? buildProjectSummary(techStack) : current.snapshot.projectSummary,
          projectSummarySource: shouldRefreshSummary ? "generated" : "manual",
          techStack
        },
        updatedAt: Date.now()
      })
    );
  });
}

/** 所有模型入口复用同一加载逻辑，确保没有工作区时保持原有无记忆行为。 */
export async function getCurrentProjectMemoryPrompt() {
  if (!getWorkspaceRoot() || !isProjectMemoryFeatureEnabled("retrievalEnabled")) return "";
  return buildProjectMemoryPrompt(await getProjectMemory());
}
