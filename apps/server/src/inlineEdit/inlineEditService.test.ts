import assert from "node:assert/strict";
import test from "node:test";
import type { InlineEditRequest } from "../contracts/inlineEdit.js";
import { extractReplacementPreview, generateInlineEdit } from "./inlineEditService.js";

const request: InlineEditRequest = {
  filePath: "src/example.ts",
  documentVersion: 7,
  documentLineCount: 3,
  selectionStartLineMaxColumn: 12,
  selectionEndLineMaxColumn: 12,
  selection: { start: { line: 2, column: 1 }, end: { line: 2, column: 12 } },
  selectedText: "const a = 1",
  instruction: "改成更清晰的变量名",
  prefix: "function demo() {",
  suffix: "}",
  languageId: "typescript"
};

test("生成并校验单文件 Inline Edit 候选", async () => {
  const result = await generateInlineEdit(request, async (_prompt, onDelta) => {
    onDelta("{\"mode\":\"inline\"}");
    return JSON.stringify({ mode: "inline", filePath: request.filePath, baseVersion: 7, range: request.selection, replacement: "const count = 1", explanation: "提高可读性" });
  }, () => undefined);
  assert.equal(result.mode, "inline");
  if (result.mode === "inline") assert.equal(result.candidate.replacement, "const count = 1");
});

test("模型返回其他文件时升级为 Patch Review", async () => {
  const result = await generateInlineEdit(request, async () => JSON.stringify({ mode: "inline", filePath: "src/other.ts", baseVersion: 7, range: request.selection, replacement: "changed" }), () => undefined);
  assert.equal(result.mode, "patch_review");
});

test("拒绝版本冲突和越界范围", async () => {
  await assert.rejects(
    () => generateInlineEdit(request, async () => JSON.stringify({ mode: "inline", filePath: request.filePath, baseVersion: 6, range: request.selection, replacement: "changed" }), () => undefined),
    /文档版本已失效/
  );
  await assert.rejects(
    () => generateInlineEdit(request, async () => JSON.stringify({ mode: "inline", filePath: request.filePath, baseVersion: 7, range: { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } }, replacement: "changed" }), () => undefined),
    /编辑范围无效/
  );
});

test("拒绝无效 JSON 和超大 replacement", async () => {
  await assert.rejects(() => generateInlineEdit(request, async () => "not-json", () => undefined), /结构化结果/);
  await assert.rejects(
    () => generateInlineEdit(request, async () => JSON.stringify({ mode: "inline", filePath: request.filePath, baseVersion: 7, range: request.selection, replacement: "x".repeat(80_001) }), () => undefined),
    /replacement cannot exceed/
  );
  await assert.rejects(
    () => generateInlineEdit(request, async () => JSON.stringify({ mode: "inline", filePath: request.filePath, baseVersion: 7, range: request.selection, replacement: request.selectedText }), () => undefined),
    /未生成有效修改/
  );
});

test("拒绝超出文档边界或起止倒置的请求选区", async () => {
  await assert.rejects(
    () => generateInlineEdit({ ...request, selection: { start: { line: 2, column: 13 }, end: { line: 2, column: 13 } } }, async () => "{}", () => undefined),
    /outside the document range/
  );
  await assert.rejects(
    () => generateInlineEdit({ ...request, selection: { start: { line: 3, column: 1 }, end: { line: 2, column: 1 } } }, async () => "{}", () => undefined),
    /outside the document range/
  );
});

test("从流式 JSON 中安全提取 replacement 增量", () => {
  assert.equal(extractReplacementPreview('{"mode":"inline","replacement":"line 1\\nline'), "line 1\nline");
  assert.equal(extractReplacementPreview('{"replacement":"中文\\u0020内容"}'), "中文 内容");
  assert.equal(extractReplacementPreview('{"mode":"inline"'), "");
});
