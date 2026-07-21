import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TaskSession } from "../../types.js";
import { migrateProjectMemory } from "../projectMemoryMigration.js";
import type { ProjectMemory } from "../types.js";

const FIXED_TIME = 1_720_000_000_000;

export type ProjectMemoryV2Fixture = {
  schemaVersion: 2;
  projectSummary: string;
  projectSummarySource?: "generated" | "manual";
  techStack: ProjectMemory["snapshot"]["techStack"];
  conventions: string[];
  currentGoals: string[];
  recentChanges: ProjectMemory["snapshot"]["recentChanges"];
  pendingItems: ProjectMemory["snapshot"]["pendingItems"];
  confirmedRisks: string[];
  createdAt: number;
  updatedAt: number;
};

// 固定的完整 V2 样本用于验证 V3 迁移，避免测试各自拼装不一致的数据。
const projectMemoryV2Fixture: ProjectMemoryV2Fixture = {
  schemaVersion: 2,
  projectSummary: "pnpm 项目，主要技术栈为 TypeScript、React，包含 2 个工作区包。",
  projectSummarySource: "manual",
  techStack: {
    packageManager: "pnpm",
    languages: ["TypeScript"],
    frameworks: ["React"],
    buildTools: ["Vite"],
    lintTools: ["ESLint"],
    typeSystems: ["TypeScript"],
    testTools: ["Node test runner"],
    workspacePackages: ["apps/server", "apps/web"],
    scannedAt: FIXED_TIME - 3_000
  },
  conventions: ["使用 pnpm", "新增代码添加必要的中文注释"],
  currentGoals: ["建立 Project Memory 回归基线"],
  recentChanges: [{
    taskSessionId: "task-success",
    summary: "完成 Project Memory V2",
    files: ["apps/server/src/projectMemory/types.ts"],
    changedAt: FIXED_TIME - 2_000
  }],
  pendingItems: [{
    taskSessionId: "task-pending",
    summary: "补充回归测试",
    status: "running",
    updatedAt: FIXED_TIME - 1_000
  }],
  confirmedRisks: ["不得覆盖损坏的记忆文件"],
  createdAt: FIXED_TIME - 10_000,
  updatedAt: FIXED_TIME
};

export function createProjectMemoryV2Fixture(overrides: Partial<ProjectMemoryV2Fixture> = {}): ProjectMemoryV2Fixture {
  return { ...structuredClone(projectMemoryV2Fixture), ...overrides };
}

export function createProjectMemoryV3Fixture(overrides: Partial<ProjectMemory> = {}): ProjectMemory {
  return { ...migrateProjectMemory(createProjectMemoryV2Fixture()), ...structuredClone(overrides) };
}

/** 创建最小 pnpm/React 工作区，供扫描、持久化与模型入口测试复用。 */
export async function createProjectMemoryTestWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-project-memory-"));
  await fs.writeFile(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify({ name: "memory-sample", packageManager: "pnpm@9", dependencies: { react: "^18.0.0" } }),
    "utf8"
  );
  await fs.writeFile(path.join(workspaceRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return workspaceRoot;
}

export function createProjectMemoryTask(overrides: Partial<TaskSession>): TaskSession {
  return {
    id: "task-default",
    userGoal: "完成默认任务",
    status: "success",
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    steps: [],
    checkpointIds: [],
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides
  };
}
