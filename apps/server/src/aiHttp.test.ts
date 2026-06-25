import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { requestChatCompletion, requestChatCompletionStream } from "./aiHttp.js";
import { projectRuntimeDirectory } from "./statePaths.js";
import { setWorkspaceRoot } from "./workspaceStore.js";

async function setupAiLogTestWorkspace() {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-http-log-"));
  await setWorkspaceRoot(workspaceRoot, { persist: false });

  const logDirectory = projectRuntimeDirectory("ai-logs");
  await fs.rm(logDirectory, { recursive: true, force: true });
  await fs.mkdir(logDirectory, { recursive: true });

  return { workspaceRoot, logDirectory };
}

async function readOnlyLogFile(logDirectory: string) {
  const fileNames = (await fs.readdir(logDirectory)).filter((fileName) => fileName.endsWith(".json"));
  assert.equal(fileNames.length, 1);

  const filePath = path.join(logDirectory, fileNames[0]);
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

test("persists full request and response bodies for non-stream chat completions", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousConfig = {
    aiApiKey: config.aiApiKey,
    aiBaseUrl: config.aiBaseUrl,
    aiFullIoLogging: config.aiFullIoLogging
  };
  const { workspaceRoot, logDirectory } = await setupAiLogTestWorkspace();

  t.after(async () => {
    globalThis.fetch = previousFetch;
    config.aiApiKey = previousConfig.aiApiKey;
    config.aiBaseUrl = previousConfig.aiBaseUrl;
    config.aiFullIoLogging = previousConfig.aiFullIoLogging;
    await fs.rm(logDirectory, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  config.aiApiKey = "test-key";
  config.aiBaseUrl = "https://example.com/v1";
  config.aiFullIoLogging = true;

  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://example.com/v1/chat/completions");
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "完整输出" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  const body = {
    model: "test-model",
    messages: [{ role: "user", content: "完整输入" }]
  };

  const result = await requestChatCompletion(body);
  assert.equal(result.choices?.[0]?.message?.content, "完整输出");

  const log = await readOnlyLogFile(logDirectory);
  assert.equal(log.mode, "non_stream");
  assert.equal(log.url, "https://example.com/v1/chat/completions");
  assert.equal(log.status, 200);
  assert.equal(log.ok, true);
  assert.deepEqual(log.requestBody, body);
  assert.equal((log.responseBody as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content, "完整输出");
});

test("persists full request body and assembled output for stream chat completions", async (t) => {
  const previousFetch = globalThis.fetch;
  const previousConfig = {
    aiApiKey: config.aiApiKey,
    aiBaseUrl: config.aiBaseUrl,
    aiFullIoLogging: config.aiFullIoLogging
  };
  const { workspaceRoot, logDirectory } = await setupAiLogTestWorkspace();

  t.after(async () => {
    globalThis.fetch = previousFetch;
    config.aiApiKey = previousConfig.aiApiKey;
    config.aiBaseUrl = previousConfig.aiBaseUrl;
    config.aiFullIoLogging = previousConfig.aiFullIoLogging;
    await fs.rm(logDirectory, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  config.aiApiKey = "test-key";
  config.aiBaseUrl = "https://example.com/v1";
  config.aiFullIoLogging = true;

  globalThis.fetch = async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "流式" } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "输出" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  const body = {
    model: "test-model",
    messages: [{ role: "user", content: "流式输入" }],
    stream: true
  };

  let streamedText = "";
  const answer = await requestChatCompletionStream(body, (delta) => {
    streamedText += delta;
  });

  assert.equal(answer, "流式输出");
  assert.equal(streamedText, "流式输出");

  const log = await readOnlyLogFile(logDirectory);
  assert.equal(log.mode, "stream");
  assert.equal(log.status, 200);
  assert.equal(log.ok, true);
  assert.deepEqual(log.requestBody, body);
  assert.equal(log.outputText, "流式输出");
  assert.equal(log.responseText, "流式输出");
});
