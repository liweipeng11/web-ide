import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearPendingPatches, createOrReusePendingPatch, getPendingPatch } from "../../patchStore.js";
import type { Task } from "../../runtime/contracts.js";
import type { DeveloperEvidence, DeveloperGraphStateValue, DeveloperModificationPlan } from "./developerGraphState.js";
import {
  createDeveloperPatchProposalNode,
  hashDeveloperPatchContent,
  proposeDeveloperPatch,
  type DeveloperPatchCandidate,
  type DeveloperPatchProposalDependencies
} from "./developerPatchProposal.js";

const task: Task = {
  id: "I1",
  type: "implement",
  goal: "更新认证模块",
  dependencies: ["E1"],
  requiredCapabilities: ["editing"],
  readScope: ["src/**"],
  writeScope: ["src/**"],
  acceptanceCriteria: ["行为保持兼容"],
  status: "pending"
};

const evidence: DeveloperEvidence[] = [
  { id: "context", kind: "context", source: "task_context", sourceRef: "I1", summary: "目标已确认", paths: [] },
  { id: "existence", kind: "existence", source: "read_tool", sourceRef: "read-1", summary: "文件状态已确认", paths: ["src/index.ts", "src/legacy.ts"] },
  { id: "pattern", kind: "pattern", source: "explorer", sourceRef: "E1", summary: "模式已确认", paths: ["src/index.ts"] },
  { id: "impact", kind: "impact", source: "explorer", sourceRef: "E1", summary: "影响已确认", paths: ["src/index.ts", "src/legacy.ts"] }
];

const modificationPlan: DeveloperModificationPlan = {
  taskId: "I1",
  summary: "更新入口并清理旧文件",
  files: [
    { path: "src/new.ts", operation: "create", reason: "新增模块", evidenceIds: ["existence", "impact"] },
    { path: "src/index.ts", operation: "modify", reason: "接入模块", evidenceIds: ["existence", "impact"] },
    { path: "src/legacy.ts", operation: "delete", reason: "移除旧模块", evidenceIds: ["existence", "impact"] }
  ]
};

function state(): DeveloperGraphStateValue {
  return {
    task,
    graphRunId: "run-1",
    status: "scope_ready",
    completedTaskIds: ["E1"],
    facts: [],
    evidence,
    missingEvidence: [],
    blockers: [],
    requiredWriteScope: [],
    modificationPlan,
    patchProposal: null
  };
}

async function fixture(context: { after(callback: () => void | Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "langgraph-patch-only-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/index.ts"), "export const value = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "src/legacy.ts"), "export const legacy = true;\n", "utf8");
  clearPendingPatches();
  context.after(async () => {
    clearPendingPatches();
    await fs.rm(root, { recursive: true, force: true });
  });
  const dependencies: DeveloperPatchProposalDependencies = {
    async inspectFile(filePath) {
      const absolutePath = path.join(root, ...filePath.replace(/\\/g, "/").split("/"));
      const content = await fs.readFile(absolutePath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      return content === null
        ? { exists: false, content: "", isBinary: false }
        : { exists: true, content, isBinary: false };
    },
    storePatch: createOrReusePendingPatch
  };
  return { root, dependencies };
}

function candidates(): DeveloperPatchCandidate[] {
  return [
    { path: "src/new.ts", operation: "create", newContent: "export const created = true;\n", summary: "新增模块" },
    {
      path: "src/index.ts",
      operation: "modify",
      newContent: "export const value = 2;\n",
      summary: "更新入口",
      baseContentHash: hashDeveloperPatchContent("export const value = 1;\n")
    },
    {
      path: "src/legacy.ts",
      operation: "delete",
      newContent: "",
      summary: "删除旧模块",
      baseContentHash: hashDeveloperPatchContent("export const legacy = true;\n")
    }
  ];
}

test("生成 create/modify/delete 待审批 Patch 且工作区保持不变", async (context) => {
  const { root, dependencies } = await fixture(context);
  const beforeIndex = await fs.readFile(path.join(root, "src/index.ts"), "utf8");
  const beforeLegacy = await fs.readFile(path.join(root, "src/legacy.ts"), "utf8");

  const result = await proposeDeveloperPatch({ state: state(), candidates: candidates(), taskSessionId: "session-1" }, dependencies);

  assert.deepEqual(result.patch.files.map((file) => file.status), ["create", "modify", "delete"]);
  assert.ok(result.patch.files.every((file) => file.diffHtml.length > 0));
  assert.equal(result.patch.source?.taskId, "I1");
  assert.equal(result.patch.source?.graphRunId, "run-1");
  assert.equal(result.patch.source?.actionId, result.stateUpdate.patchProposal.actionId);
  assert.deepEqual(result.patch.source?.evidenceIds, ["existence", "impact"]);
  assert.equal(await fs.readFile(path.join(root, "src/index.ts"), "utf8"), beforeIndex);
  assert.equal(await fs.readFile(path.join(root, "src/legacy.ts"), "utf8"), beforeLegacy);
  assert.equal(await fs.stat(path.join(root, "src/new.ts")).then(() => true).catch(() => false), false);
});

test("相同 task、graph run 和候选内容重复执行时复用同一 Patch", async (context) => {
  const { dependencies } = await fixture(context);
  const first = await proposeDeveloperPatch({ state: state(), candidates: candidates() }, dependencies);
  const second = await proposeDeveloperPatch({ state: state(), candidates: candidates() }, dependencies);

  assert.equal(second.patch.patchId, first.patch.patchId);
  assert.equal(second.patch.createdAt, first.patch.createdAt);
  assert.equal(getPendingPatch(first.patch.patchId), first.patch);
});

test("基础内容哈希过期时拒绝候选且不创建 Pending Patch", async (context) => {
  const { dependencies } = await fixture(context);
  let stored = 0;
  const stale = candidates();
  stale[1] = { ...stale[1], baseContentHash: hashDeveloperPatchContent("旧快照") };

  await assert.rejects(
    () => proposeDeveloperPatch({ state: state(), candidates: stale }, {
      ...dependencies,
      storePatch(input) {
        stored += 1;
        return dependencies.storePatch(input);
      }
    }),
    /基础内容已过期/
  );
  assert.equal(stored, 0);
});

test("计划外路径或操作类型不一致时在读取文件前拒绝", async () => {
  let inspections = 0;
  const dependencies: DeveloperPatchProposalDependencies = {
    async inspectFile() {
      inspections += 1;
      return { exists: false, content: "", isBinary: false };
    },
    storePatch: createOrReusePendingPatch
  };

  await assert.rejects(
    () => proposeDeveloperPatch({
      state: state(),
      candidates: [{ path: "src/index.ts", operation: "delete", newContent: "", summary: "错误操作" }]
    }, dependencies),
    /超出结构化修改计划/
  );
  assert.equal(inspections, 0);
});

test("Patch 提议节点只把稳定引用写回 Graph 状态", async (context) => {
  const { dependencies } = await fixture(context);
  const node = createDeveloperPatchProposalNode(async () => candidates(), { dependencies });

  const update = await node(state());

  assert.equal(update.status, "patch_pending_approval");
  assert.match(update.patchProposal?.patchId || "", /^patch-[a-f0-9]{32}$/);
  assert.deepEqual(update.patchProposal?.filePaths, ["src/new.ts", "src/index.ts", "src/legacy.ts"]);
  assert.equal("files" in (update.patchProposal || {}), false);
});
