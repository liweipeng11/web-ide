import { HttpError } from "../errors.js";
import { analyzeProject } from "../projectAnalyzer.js";
import { listTaskSessions } from "../taskSessionStore.js";
import type { TaskSession } from "../types.js";
import { getWorkspaceRoot } from "../workspaceStore.js";
import { normalizeProjectMemory, readProjectMemory, writeProjectMemory } from "./projectMemoryStore.js";
import { PROJECT_MEMORY_SCHEMA_VERSION, type ProjectMemory, type ProjectMemoryTechStack, type UpdateProjectMemoryInput } from "./types.js";
import { buildProjectMemoryPrompt } from "./projectMemoryPrompt.js";

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
    projectSummary: buildProjectSummary(techStack),
    projectSummarySource: "generated",
    techStack,
    conventions: [],
    currentGoals: [],
    recentChanges: [],
    pendingItems: [],
    confirmedRisks: [],
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
    .map(({ session, files }) => ({ taskSessionId: session.id, summary: session.userGoal, files, changedAt: session.updatedAt }));
  // 最近改动是长期事实：任务历史被清理后仍保留已同步摘要；同一任务的新事实覆盖旧快照。
  const recentChangesByTask = new Map(memory.recentChanges.map((change) => [change.taskSessionId, change]));
  sessionChanges.forEach((change) => recentChangesByTask.set(change.taskSessionId, change));
  const recentChanges = [...recentChangesByTask.values()].sort((left, right) => right.changedAt - left.changedAt).slice(0, 20);
  const pendingItems = ordered
    .filter((session) => session.status !== "success" && session.status !== "cancelled")
    .map((session) => ({ taskSessionId: session.id, summary: session.userGoal, status: session.status, updatedAt: session.updatedAt }))
    .slice(0, 20);

  const unchanged = JSON.stringify(memory.recentChanges) === JSON.stringify(recentChanges) && JSON.stringify(memory.pendingItems) === JSON.stringify(pendingItems);
  if (unchanged) return memory;

  return normalizeProjectMemory({ ...memory, recentChanges, pendingItems, updatedAt: Date.now() });
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
  const root = requireWorkspaceRoot(workspaceRoot);
  return enqueueMemoryOperation(root, async () => {
    const current = await loadProjectMemory({ workspaceRoot: root });
    const next = normalizeProjectMemory({
      ...current,
      ...input,
      projectSummarySource: input.projectSummary === undefined ? current.projectSummarySource : "manual",
      updatedAt: Date.now()
    });
    return writeProjectMemory(root, next);
  });
}

export async function refreshProjectMemoryAnalysis(workspaceRoot?: string) {
  const root = requireWorkspaceRoot(workspaceRoot);
  return enqueueMemoryOperation(root, async () => {
    const current = await loadProjectMemory({ workspaceRoot: root });
    const techStack = buildTechStack(await analyzeProject(root));
    const previousGeneratedSummary = buildProjectSummary(current.techStack);
    const shouldRefreshSummary = current.projectSummarySource === "generated" || current.projectSummary === previousGeneratedSummary;
    return writeProjectMemory(
      root,
      normalizeProjectMemory({
        ...current,
        // 旧版本通过内容比对识别自动摘要；明确手工维护的简介不会被重新扫描覆盖。
        projectSummary: shouldRefreshSummary ? buildProjectSummary(techStack) : current.projectSummary,
        projectSummarySource: shouldRefreshSummary ? "generated" : "manual",
        techStack,
        updatedAt: Date.now()
      })
    );
  });
}

/** 所有模型入口复用同一加载逻辑，确保没有工作区时保持原有无记忆行为。 */
export async function getCurrentProjectMemoryPrompt() {
  if (!getWorkspaceRoot()) return "";
  return buildProjectMemoryPrompt(await getProjectMemory());
}
