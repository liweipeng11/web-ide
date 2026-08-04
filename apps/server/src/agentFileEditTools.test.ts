import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContextCache } from "./codeDiscovery/index.js";
import { executeAgentToolCall } from "./agentTools.js";
import { getCheckpoint, rollbackCheckpoint } from "./checkpointStore.js";
import { fileEditToolDefinitions } from "./fileEditTools.js";
import { runtimeAgentToolRegistry } from "./runtimeAgentTools.js";
import { projectRuntimeDirectory } from "./statePaths.js";
import { createTaskSession, getTaskSession } from "./taskSessionStore.js";
import { clearTaskMetricsForTest, getTaskSessionPersistenceMetrics } from "./observability/index.js";
import { setWorkspaceRoot } from "./workspaceStore.js";
import type { AgentFileEditToolResult, AgentToolRuntime } from "./agentToolTypes.js";
import type { AgentStep } from "./types.js";
import type { ImpactAnalysisResult } from "./impactAnalyzer/index.js";

function createToolRuntime(options: Partial<AgentToolRuntime> = {}): AgentToolRuntime & { registry: typeof runtimeAgentToolRegistry } {
  return {
    agentContext: {
      userGoal: "edit files with direct tools",
      filesRead: [],
      searchQueries: [],
      searchResultFiles: [],
      relevantFiles: []
    },
    runId: "test-agent-file-edit-tool",
    cache: createContextCache(),
    registry: runtimeAgentToolRegistry,
    ...options
  };
}

async function withTempWorkspace(run: (workspaceRoot: string) => Promise<void>) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-ai-agent-file-edit-"));

  try {
    await setWorkspaceRoot(workspaceRoot, { persist: false });
    await run(workspaceRoot);
  } finally {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function listCheckpointFiles() {
  return fs.readdir(projectRuntimeDirectory("checkpoints")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
}

test("runtime registry 同时暴露新编辑工具和旧 patch 工具", () => {
  assert.ok(runtimeAgentToolRegistry.get("replaceInFile"));
  assert.ok(runtimeAgentToolRegistry.get("writeFile"));
  assert.ok(runtimeAgentToolRegistry.get("proposePatch"));
  assert.ok(runtimeAgentToolRegistry.get("applyPatch"));
});

test("replaceInFile 工具会写入文件并返回 finalContent", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "replaceInFile");

    assert.ok(tool);
    const result = (await tool.execute(
      {
        filePath: "target.ts",
        search: "value = 1",
        replace: "value = 2"
      },
      createToolRuntime()
    )) as AgentFileEditToolResult;

    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(result.filePath, "target.ts");
    assert.equal(result.changed, true);
    assert.equal(result.replacements, 1);
    assert.equal(result.oldContentPreview, "export const value = 1;\n");
    assert.equal(result.finalContent, "export const value = 2;\n");
  });
});

test("replaceInFile 会阻止修改影响分析最小范围之外的文件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "replaceInFile");
    const impactAnalysis: ImpactAnalysisResult = {
      changes: [{ filePath: "service.ts", changeKind: "modify", status: "resolved", definitions: [] }],
      impactedFiles: [], relatedTests: [], boundaryFiles: [], risk: { level: "low", score: 0, factors: [] }, diagnostics: [], complete: true, truncated: false,
      indexedFileCount: 2, indexedSymbolCount: 1, unresolvedReferenceCount: 0, indexedUnresolvedReferenceCount: 0
    };

    assert.ok(tool);
    await assert.rejects(
      () => tool.execute({ filePath: "target.ts", search: "value = 1", replace: "value = 2" }, createToolRuntime({ agentContext: { userGoal: "修改服务", filesRead: ["service.ts", "target.ts"], searchQueries: [], searchResultFiles: [], relevantFiles: [], impactAnalyses: [impactAnalysis] } })),
      /Safe Editor blocked risky direct edit/
    );
    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "export const value = 1;\n");
  });
});

test("writeFile 不会把已存在文件因 createIfMissing=true 误判为新增文件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "other.ts"), "export const other = 1;\n", "utf8");
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "writeFile");
    const impactAnalysis: ImpactAnalysisResult = {
      changes: [{ filePath: "src/service.ts", changeKind: "modify", status: "resolved", definitions: [] }], impactedFiles: [], relatedTests: [], boundaryFiles: [],
      risk: { level: "low", score: 0, factors: [] }, diagnostics: [], complete: true, truncated: false, indexedFileCount: 2, indexedSymbolCount: 1, unresolvedReferenceCount: 0, indexedUnresolvedReferenceCount: 0
    };

    assert.ok(tool);
    await assert.rejects(
      () => tool.execute({ filePath: "src/other.ts", content: "export const other = 2;\n", createIfMissing: true }, createToolRuntime({ agentContext: { userGoal: "修改服务", filesRead: ["src/service.ts", "src/other.ts"], searchQueries: [], searchResultFiles: [], relevantFiles: [], impactAnalyses: [impactAnalysis] } })),
      /Safe Editor blocked risky direct edit/
    );
    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "other.ts"), "utf8"), "export const other = 1;\n");
  });
});

test("replaceInFile 在无影响分析时仍会检查真实格式化 diff", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "const value=1;\n", "utf8");
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "replaceInFile");

    assert.ok(tool);
    await assert.rejects(() => tool.execute({ filePath: "target.ts", search: "value=1", replace: "value = 1" }, createToolRuntime()), /Safe Editor blocked risky direct edit/);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "const value=1;\n");
  });
});

test("replaceInFile 工具会记录 task session 事件并生成可回滚 checkpoint", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "const value = 'before';\n", "utf8");
    const session = await createTaskSession("记录工具式编辑");
    await clearTaskMetricsForTest({ key: session.id });
    const steps: AgentStep[] = [];

    const message = await executeAgentToolCall(
      {
        id: "tool-replace-session-1",
        type: "function",
        function: {
          name: "replaceInFile",
          arguments: JSON.stringify({
            filePath: "target.ts",
            search: "before",
            replace: "after"
          })
        }
      },
      createToolRuntime({
        taskSessionId: session.id,
        onAgentStep(step) {
          steps.push(step);
        }
      })
    );
    const content = JSON.parse(message.content) as AgentFileEditToolResult;
    const loaded = await getTaskSession(session.id);

    assert.equal(content.checkpointId, loaded.checkpointIds[0]);
    assert.ok(content.checkpointId);
    assert.deepEqual(
      loaded.fileEditEvents?.map((event) => event.type),
      ["file_edit_started", "file_edit_applied"]
    );
    assert.equal(loaded.fileEditEvents?.[1]?.checkpointId, content.checkpointId);
    assert.deepEqual(loaded.filesChanged, ["target.ts"]);
    assert.equal(steps.some((step) => step.type === "checkpoint" && step.checkpointId === content.checkpointId), true);
    const persistenceMetrics = await getTaskSessionPersistenceMetrics(session.id);
    assert.equal(persistenceMetrics.taskSessionUpdateCount, 4);
    assert.equal(persistenceMetrics.taskSessionPhysicalWriteCount, 2);
    assert.equal(persistenceMetrics.taskSessionWriteCoalescedCount, 2);

    const checkpoint = await getCheckpoint(content.checkpointId || "");
    assert.equal(checkpoint.source?.toolCallId, "tool-replace-session-1");
    assert.equal(checkpoint.files[0].beforeContent, "const value = 'before';\n");
    assert.equal(checkpoint.files[0].afterContent, "const value = 'after';\n");

    await rollbackCheckpoint(content.checkpointId || "");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "const value = 'before';\n");
    await clearTaskMetricsForTest({ key: session.id });
  });
});

test("无变化编辑不会创建 checkpoint 或更新任务会话生命周期", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "export const value = 1;\n", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "note.txt"), "same content\n", "utf8");
    const session = await createTaskSession("忽略无变化编辑");
    const steps: AgentStep[] = [];
    const runtime = createToolRuntime({
      taskSessionId: session.id,
      agentContext: {
        userGoal: "忽略无变化编辑",
        filesRead: ["target.ts", "note.txt"],
        searchQueries: [],
        searchResultFiles: [],
        relevantFiles: []
      },
      onAgentStep(step) {
        steps.push(step);
      }
    });
    const checkpointFilesBefore = await listCheckpointFiles();
    const taskSessionPath = path.join(projectRuntimeDirectory("task-sessions"), `${session.id}.json`);
    const stableTime = new Date("2020-01-02T03:04:05.000Z");
    await fs.utimes(taskSessionPath, stableTime, stableTime);
    const taskSessionMtimeBefore = (await fs.stat(taskSessionPath)).mtimeMs;

    const replaceMessage = await executeAgentToolCall(
      {
        id: "tool-replace-no-op-1",
        type: "function",
        function: {
          name: "replaceInFile",
          arguments: JSON.stringify({ filePath: "target.ts", search: "value = 1", replace: "value = 1" })
        }
      },
      runtime
    );
    const writeMessage = await executeAgentToolCall(
      {
        id: "tool-write-no-op-1",
        type: "function",
        function: {
          name: "writeFile",
          arguments: JSON.stringify({ filePath: "note.txt", content: "same content\n" })
        }
      },
      runtime
    );

    const replaceResult = JSON.parse(replaceMessage.content) as AgentFileEditToolResult;
    const writeResult = JSON.parse(writeMessage.content) as AgentFileEditToolResult;
    const loaded = await getTaskSession(session.id);

    assert.equal(replaceResult.changed, false);
    assert.equal(replaceResult.replacements, 1);
    assert.equal(replaceResult.finalContent, "export const value = 1;\n");
    assert.equal(replaceResult.checkpointId, undefined);
    assert.equal(writeResult.changed, false);
    assert.equal(writeResult.finalContent, "same content\n");
    assert.equal(writeResult.checkpointId, undefined);
    assert.deepEqual(loaded.checkpointIds, []);
    assert.deepEqual(loaded.filesChanged, []);
    assert.deepEqual(loaded.fileEditEvents, []);
    assert.equal(steps.some((step) => step.type === "checkpoint"), false);
    assert.deepEqual(await listCheckpointFiles(), checkpointFilesBefore);
    // no-op 不触发任何任务会话更新，持久化 JSON 的修改时间也必须保持不变。
    assert.equal((await fs.stat(taskSessionPath)).mtimeMs, taskSessionMtimeBefore);
  });
});

test("writeFile 新建文件的 checkpoint 回滚会删除创建的文件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const session = await createTaskSession("记录新建文件编辑");

    const message = await executeAgentToolCall(
      {
        id: "tool-write-session-1",
        type: "function",
        function: {
          name: "writeFile",
          arguments: JSON.stringify({
            filePath: "src/created.ts",
            content: "export const created = true;\n",
            createIfMissing: true
          })
        }
      },
      createToolRuntime({
        taskSessionId: session.id
      })
    );
    const content = JSON.parse(message.content) as AgentFileEditToolResult;
    const checkpoint = await getCheckpoint(content.checkpointId || "");

    assert.equal(checkpoint.files[0].beforeExists, false);
    assert.equal(checkpoint.files[0].afterExists, true);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "created.ts"), "utf8"), "export const created = true;\n");

    await rollbackCheckpoint(content.checkpointId || "");
    await assert.rejects(() => fs.readFile(path.join(workspaceRoot, "src", "created.ts"), "utf8"), /ENOENT/);
  });
});

test("replaceInFile 失败时会记录 file_edit_failed 事件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "const value = 'before';\n", "utf8");
    const session = await createTaskSession("记录工具式编辑失败");

    const message = await executeAgentToolCall(
      {
        id: "tool-replace-failed-1",
        type: "function",
        function: {
          name: "replaceInFile",
          arguments: JSON.stringify({
            filePath: "target.ts",
            search: "missing",
            replace: "after"
          })
        }
      },
      createToolRuntime({
        taskSessionId: session.id
      })
    );
    const content = JSON.parse(message.content) as {
      error?: string;
      errorCode?: string;
      retryable?: boolean;
      suggestedAction?: string;
    };
    const loaded = await getTaskSession(session.id);

    assert.match(content.error || "", /Search block was not found/);
    assert.equal(content.errorCode, "SEARCH_BLOCK_NOT_FOUND");
    assert.equal(content.retryable, true);
    assert.match(content.suggestedAction || "", /先读取 target\.ts/);
    assert.deepEqual(
      loaded.fileEditEvents?.map((event) => event.type),
      ["file_edit_started", "file_edit_failed"]
    );
    assert.equal(loaded.checkpointIds.length, 0);
  });
});

test("writeFile 工具支持创建新文件并返回 finalContent", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "writeFile");

    assert.ok(tool);
    const result = (await tool.execute(
      {
        filePath: "src/new-file.ts",
        content: "export const created = true;\n",
        createIfMissing: true
      },
      createToolRuntime()
    )) as AgentFileEditToolResult;

    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "new-file.ts"), "utf8"), "export const created = true;\n");
    assert.equal(result.filePath, "src/new-file.ts");
    assert.equal(result.changed, true);
    assert.equal(result.oldContentPreview, "");
    assert.equal(result.finalContent, "export const created = true;\n");
  });
});

test("writeFile 的 createIfMissing 授权不能覆盖未读取的已有文件", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "src", "existing.ts"), "export const value = 1;\n", "utf8");
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "writeFile");

    assert.ok(tool);
    await assert.rejects(
      () => tool.execute(
        {
          filePath: "src/existing.ts",
          content: "export const value = 2;\n",
          createIfMissing: true
        },
        createToolRuntime()
      ),
      /Cannot overwrite unread file/
    );
    assert.equal(await fs.readFile(path.join(workspaceRoot, "src", "existing.ts"), "utf8"), "export const value = 1;\n");
  });
});

test("writeFile 创建工作区外文件仍会被路径策略阻止", async () => {
  await withTempWorkspace(async () => {
    const tool = fileEditToolDefinitions.find((definition) => definition.name === "writeFile");

    assert.ok(tool);
    await assert.rejects(
      () => tool.execute(
        {
          filePath: "../outside.ts",
          content: "export const outside = true;\n",
          createIfMissing: true
        },
        createToolRuntime()
      ),
      /outside WORKSPACE_ROOT/
    );
  });
});

test("executeAgentToolCall 会为编辑工具产生日志步骤和工具结果", async () => {
  await withTempWorkspace(async (workspaceRoot) => {
    await fs.writeFile(path.join(workspaceRoot, "target.ts"), "const name = 'old';\n", "utf8");
    const steps: AgentStep[] = [];

    const message = await executeAgentToolCall(
      {
        id: "tool-replace-1",
        type: "function",
        function: {
          name: "replaceInFile",
          arguments: JSON.stringify({
            filePath: "target.ts",
            search: "old",
            replace: "new"
          })
        }
      },
      createToolRuntime({
        emitToolApprovalSteps: true,
        onAgentStep(step) {
          steps.push(step);
        }
      })
    );
    const content = JSON.parse(message.content) as AgentFileEditToolResult;
    const resultStep = steps.find((step) => step.type === "tool_result" && step.toolName === "replaceInFile");

    assert.equal(content.finalContent, "const name = 'new';\n");
    assert.equal(await fs.readFile(path.join(workspaceRoot, "target.ts"), "utf8"), "const name = 'new';\n");
    assert.ok(steps.some((step) => step.type === "approval_request" && step.actionType === "edit_files"));
    assert.ok(resultStep);
    if (resultStep.type !== "tool_result") {
      throw new Error("Expected a tool_result step for replaceInFile");
    }
    assert.equal((resultStep.output as { finalContent?: string }).finalContent, "const name = 'new';\n");
  });
});
