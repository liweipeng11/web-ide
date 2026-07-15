import { deleteReasoningAudit, getReasoningAuditDisplayPath, readReasoningAudit, writeReasoningAudit } from "./reasoningStore.js";
import type { ReasoningAudit, ReasoningSequenceInput, ReasoningSequenceResult } from "./types.js";

const MAX_THOUGHTS_PER_SEQUENCE = 64;

function validateReasoningInput(input: ReasoningSequenceInput) {
  if (!input.thought.trim()) throw new Error("thought is required");
  if (!Number.isInteger(input.thoughtNumber) || input.thoughtNumber < 1) throw new Error("thoughtNumber must be a positive integer");
  if (!Number.isInteger(input.totalThoughts) || input.totalThoughts < input.thoughtNumber) throw new Error("totalThoughts must be greater than or equal to thoughtNumber");
  if (input.totalThoughts > MAX_THOUGHTS_PER_SEQUENCE) throw new Error(`totalThoughts must not exceed ${MAX_THOUGHTS_PER_SEQUENCE}`);
  if (input.isRevision && (!input.revisesThought || input.revisesThought >= input.thoughtNumber)) throw new Error("A revision must reference an earlier thought");
  if (input.branchFromThought && input.branchFromThought >= input.thoughtNumber) throw new Error("branchFromThought must reference an earlier thought");
}

function createAudit(runId: string): ReasoningAudit {
  const now = new Date().toISOString();
  return { schemaVersion: 1, runId, branches: {}, completedBranches: [], createdAt: now, updatedAt: now };
}

/** 记录并持久化显式推理步骤，使任务完成或服务重启后仍可审计。 */
export async function recordReasoningThought(runId: string, input: ReasoningSequenceInput): Promise<ReasoningSequenceResult> {
  validateReasoningInput(input);
  const branchId = input.branchId?.trim() || "main";
  const audit = (await readReasoningAudit(runId)) || createAudit(runId);
  const existing = audit.branches[branchId] || [];
  if (audit.completedBranches.includes(branchId)) throw new Error(`Reasoning branch ${branchId} is already complete`);

  const mainThoughts = audit.branches.main || [];
  if (input.branchFromThought && !mainThoughts.some((thought) => thought.thoughtNumber === input.branchFromThought)) {
    throw new Error(`branchFromThought ${input.branchFromThought} does not exist in the main branch`);
  }
  if (input.isRevision && !existing.some((thought) => thought.thoughtNumber === input.revisesThought)) {
    throw new Error(`revisesThought ${input.revisesThought} does not exist in branch ${branchId}`);
  }

  const expectedNumber = existing.length ? existing.at(-1)!.thoughtNumber + 1 : input.branchFromThought ? input.branchFromThought + 1 : 1;
  if (input.thoughtNumber !== expectedNumber) throw new Error(`Expected thoughtNumber ${expectedNumber} for branch ${branchId}`);

  existing.push({ ...input, thought: input.thought.trim(), branchId, recordedAt: new Date().toISOString() });
  audit.branches[branchId] = existing;
  audit.updatedAt = new Date().toISOString();
  if (!input.nextThoughtNeeded) audit.completedBranches = [...new Set([...audit.completedBranches, branchId])];
  const auditPath = await writeReasoningAudit(audit);

  return {
    accepted: true,
    thoughtNumber: input.thoughtNumber,
    totalThoughts: input.totalThoughts,
    nextThoughtNumber: input.nextThoughtNeeded ? input.thoughtNumber + 1 : null,
    complete: !input.nextThoughtNeeded,
    branchId,
    recordedThoughtCount: existing.length,
    auditPath
  };
}

export async function clearReasoningSequence(runId: string) {
  await deleteReasoningAudit(runId);
}

export { getReasoningAuditDisplayPath, readReasoningAudit };
