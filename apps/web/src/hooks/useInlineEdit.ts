import { useRef, useState } from "react";
import { streamInlineEdit, type InlineEditCandidate, type InlineEditRequest } from "../api";

export type InlineEditDraft = Omit<InlineEditRequest, "instruction">;
export type InlineEditStatus = "idle" | "generating" | "ready" | "stopped" | "error";

export type InlineEditUpgradeRequest = { instruction: string; reason: string; draft: InlineEditDraft };
export type InlineEditChangeContext = { instruction: string; draft: InlineEditDraft };

export function useInlineEdit(options: { onPatchReview: (request: InlineEditUpgradeRequest) => Promise<void> }) {
  const [draft, setDraft] = useState<InlineEditDraft | null>(null);
  const [instruction, setInstruction] = useState("");
  const [candidate, setCandidate] = useState<InlineEditCandidate | null>(null);
  const [status, setStatus] = useState<InlineEditStatus>("idle");
  const [generatedCharacters, setGeneratedCharacters] = useState(0);
  const [streamedReplacement, setStreamedReplacement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function open(nextDraft: InlineEditDraft, initialInstruction = "") {
    abortRef.current?.abort();
    setDraft(nextDraft);
    setInstruction(initialInstruction);
    setCandidate(null);
    setGeneratedCharacters(0);
    setStreamedReplacement("");
    setError(null);
    setStatus("idle");
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setDraft(null);
    setInstruction("");
    setCandidate(null);
    setGeneratedCharacters(0);
    setStreamedReplacement("");
    setError(null);
    setStatus("idle");
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("stopped");
  }

  async function generate() {
    const normalizedInstruction = instruction.trim();
    if (!draft || !normalizedInstruction) {
      setError("请输入修改要求");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setCandidate(null);
    setGeneratedCharacters(0);
    setStreamedReplacement("");
    setError(null);
    setStatus("generating");

    try {
      await streamInlineEdit({ ...draft, instruction: normalizedInstruction }, (event) => {
        if (event.type === "delta") setGeneratedCharacters(event.generatedCharacters);
        if (event.type === "candidate_delta") setStreamedReplacement(event.replacement);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "result") {
          if (event.result.mode === "inline") {
            setCandidate(event.result.candidate);
            setStatus("ready");
          } else {
            const upgradeRequest = { instruction: normalizedInstruction, reason: event.result.reason, draft };
            reset();
            void options.onPatchReview(upgradeRequest);
          }
        }
      }, controller.signal);
    } catch (requestError) {
      if (controller.signal.aborted) {
        setStatus("stopped");
      } else {
        setError(requestError instanceof Error ? requestError.message : "Inline Edit 生成失败");
        setStatus("error");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  return { draft, instruction, setInstruction, candidate, status, generatedCharacters, streamedReplacement, error, open, reset, stop, generate };
}
