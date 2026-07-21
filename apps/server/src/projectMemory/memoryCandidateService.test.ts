import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { setWorkspaceRoot } from "../workspaceStore.js";
import { createProjectMemoryTestWorkspace } from "./fixtures/projectMemoryV2.fixture.js";
import { acceptMemoryCandidate, createMemoryCandidate, deleteMemoryItem, listMemoryCandidates, rejectMemoryCandidate, updateMemoryCandidate } from "./memoryCandidateService.js";
import { getProjectMemory } from "./projectMemoryService.js";

async function createWorkspace(context: test.TestContext) {
  const workspaceRoot = await createProjectMemoryTestWorkspace();
  context.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  await setWorkspaceRoot(workspaceRoot, { persist: false });
  return workspaceRoot;
}

test("创建候选会规范化、精确去重并记录来源", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  const input = {
    kind: "decision" as const,
    content: "  API 层统一返回 DTO  ",
    sourceRefs: [{ type: "user" as const, value: "message-1" }],
    createdBy: "user" as const,
    confidence: 1
  };

  const first = await createMemoryCandidate(input, workspaceRoot);
  const duplicate = await createMemoryCandidate({ ...input, content: "API 层统一返回 DTO。" }, workspaceRoot);

  assert.equal(first.created, true);
  assert.equal(first.candidate.status, "candidate");
  assert.equal(first.candidate.createdBy, "user");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.candidate.id, first.candidate.id);
  assert.equal((await listMemoryCandidates(workspaceRoot)).length, 1);
});

test("候选只有用户接受后才激活，拒绝后保留审计状态但不再列出", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  const first = await createMemoryCandidate({
    kind: "fact",
    content: "服务端使用 Node test runner",
    sourceRefs: [{ type: "task", value: "task-1" }],
    createdBy: "system",
    confidence: 0.9
  }, workspaceRoot);
  const edited = await updateMemoryCandidate(first.candidate.id, { content: "服务端测试使用 Node test runner" }, workspaceRoot);
  const accepted = await acceptMemoryCandidate(edited.id, workspaceRoot);
  assert.equal(accepted.status, "active");
  await assert.rejects(() => updateMemoryCandidate(accepted.id, { content: "非法改写" }, workspaceRoot), /Only candidate/);

  const second = await createMemoryCandidate({
    kind: "risk",
    content: "旧接口仍有兼容风险",
    sourceRefs: [{ type: "user", value: "message-2" }],
    createdBy: "user",
    confidence: 1
  }, workspaceRoot);
  await rejectMemoryCandidate(second.candidate.id, workspaceRoot);
  const memory = await getProjectMemory({ workspaceRoot, syncTasks: false });
  assert.equal(memory.items.find((item) => item.id === second.candidate.id)?.status, "rejected");
  assert.equal((await listMemoryCandidates(workspaceRoot)).length, 0);
});

test("简单否定冲突会被提示，敏感内容不会持久化", async (context) => {
  const workspaceRoot = await createWorkspace(context);
  const active = await createMemoryCandidate({
    kind: "decision",
    content: "必须使用 npm",
    sourceRefs: [{ type: "user", value: "message-1" }],
    createdBy: "user",
    confidence: 1
  }, workspaceRoot);
  await acceptMemoryCandidate(active.candidate.id, workspaceRoot);
  const conflict = await createMemoryCandidate({
    kind: "decision",
    content: "禁止使用 npm",
    sourceRefs: [{ type: "user", value: "message-2" }],
    createdBy: "user",
    confidence: 1
  }, workspaceRoot);
  assert.deepEqual(conflict.conflictIds, [active.candidate.id]);

  await assert.rejects(() => createMemoryCandidate({
    kind: "fact",
    content: "DATABASE_URL=postgres://admin:secret@localhost/app",
    sourceRefs: [{ type: "user", value: "message-3" }],
    createdBy: "user",
    confidence: 1
  }, workspaceRoot), /sensitive information/);
  assert.equal((await getProjectMemory({ workspaceRoot, syncTasks: false })).items.length, 2);

  await deleteMemoryItem(active.candidate.id, workspaceRoot);
  assert.ok(!(await getProjectMemory({ workspaceRoot, syncTasks: false })).items.some((item) => item.id === active.candidate.id));
});
