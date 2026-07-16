import { Router } from "express";
import { config } from "../config.js";
import type { InlineEditRequest, InlineEditStreamEvent } from "../contracts/inlineEdit.js";
import { requestChatCompletionStream } from "../modelGatewayClient.js";
import { withModelExecution } from "../modelExecutionContext.js";
import { resolveModelSelection } from "../modelSelectionStore.js";
import { generateInlineEdit, type InlineEditGenerator } from "./inlineEditService.js";
import { buildInlineEditRelatedContext } from "./inlineEditContext.js";

function sendEvent(response: import("express").Response, event: InlineEditStreamEvent) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

export function createInlineEditRouter(options: { generator?: InlineEditGenerator } = {}) {
  const router = Router();

  router.post("/inline-edit/stream", async (request, response) => {
    const controller = new AbortController();
    let finished = false;
    response.on("close", () => {
      if (!finished) controller.abort();
    });
    response.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    response.flushHeaders();
    sendEvent(response, { type: "started" });

    try {
      const runId = `inline-edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const selection = config.featureFlags.modelProviderGateway
        ? await resolveModelSelection("chat")
        : { providerId: "openai-compatible", modelId: config.aiModel };
      const generator: InlineEditGenerator = options.generator ?? ((prompt, onDelta, signal) => withModelExecution(
        { selection, taskSessionId: runId, mode: "chat" },
        () => requestChatCompletionStream({ model: selection.modelId, temperature: 0.1, messages: [{ role: "system", content: "Return strict JSON only." }, { role: "user", content: prompt }] }, onDelta, signal)
      ));
      const inlineRequest = request.body as InlineEditRequest;
      const relatedContext = inlineRequest.relatedContext ?? await buildInlineEditRelatedContext(inlineRequest).catch(() => null);
      let lastReplacementPreview = "";
      const result = await generateInlineEdit({ ...inlineRequest, relatedContext }, generator, (generatedCharacters, replacementPreview) => {
        sendEvent(response, { type: "delta", generatedCharacters });
        if (replacementPreview !== lastReplacementPreview) {
          lastReplacementPreview = replacementPreview;
          sendEvent(response, { type: "candidate_delta", replacement: replacementPreview });
        }
      }, controller.signal);
      sendEvent(response, { type: "result", result });
    } catch (error) {
      if (!controller.signal.aborted) sendEvent(response, { type: "error", message: error instanceof Error ? error.message : "Inline Edit 生成失败" });
    } finally {
      finished = true;
      response.end();
    }
  });

  return router;
}
