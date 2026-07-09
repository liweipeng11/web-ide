import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLegacySingleFileEdit, parseAiEditResult } from "./aiClient.js";
import { HttpError } from "./errors.js";

test("parseAiEditResult parses local search/replace edit patches", () => {
  const result = parseAiEditResult(
    JSON.stringify({
      status: "patch",
      summary: "add nav item",
      patches: [
        {
          filePath: "src/App.vue",
          oldContent: "",
          newContent: "",
          edits: [{ search: "<nav>Home</nav>", replace: "<nav>Home Tools</nav>" }],
          summary: "update nav"
        }
      ]
    })
  );

  assert.equal(result.patches?.[0]?.edits?.[0]?.search, "<nav>Home</nav>");
});

test("parseAiEditResult keeps legacy patch JSON available for explicit fallback workflows", () => {
  const result = parseAiEditResult(
    JSON.stringify({
      status: "patch",
      summary: "fallback pending patch",
      patches: [
        {
          filePath: "src/App.tsx",
          status: "modify",
          oldContent: "",
          newContent: "",
          edits: [{ search: "const title = 'old';", replace: "const title = 'new';" }],
          summary: "update title"
        }
      ],
      commandsToRun: ["pnpm --filter @mini-ai-web-editor/server test"]
    })
  );

  // 旧 parser 只服务 /api/generate-edit 与显式 proposePatch，不参与直写工具结果解析。
  assert.equal(result.status, "patch");
  assert.equal(result.patches?.[0]?.filePath, "src/App.tsx");
  assert.deepEqual(result.commandsToRun, ["pnpm --filter @mini-ai-web-editor/server test"]);
});

test("parseAiEditResult rejects full-file patches without explicit newContent", () => {
  assert.throws(
    () =>
      parseAiEditResult(
        JSON.stringify({
          status: "patch",
          summary: "bad patch",
          patches: [
            {
              filePath: "src/App.vue",
              oldContent: "current",
              summary: "missing content"
            }
          ]
        })
      ),
    (error) => error instanceof HttpError && error.status === 502
  );
});

test("parseAiEditResult parses explicit delete patches without full newContent", () => {
  const result = parseAiEditResult(
    JSON.stringify({
      status: "patch",
      summary: "remove obsolete module",
      patches: [
        {
          filePath: "src/obsolete.ts",
          status: "delete",
          oldContent: "export const obsolete = true;\n",
          summary: "delete obsolete module"
        }
      ]
    })
  );

  assert.equal(result.patches?.[0]?.filePath, "src/obsolete.ts");
  assert.equal(result.patches?.[0]?.status, "delete");
  assert.equal(result.patches?.[0]?.newContent, "");
});

test("normalizeLegacySingleFileEdit converts top-level newContent when selected file is known", () => {
  const result = normalizeLegacySingleFileEdit(
    JSON.stringify({
      status: "patch",
      summary: "legacy single file edit",
      oldContent: "before",
      newContent: "after"
    }),
    "src/App.vue"
  );

  assert.equal(result?.patches?.[0]?.filePath, "src/App.vue");
  assert.equal(result?.patches?.[0]?.oldContent, "before");
  assert.equal(result?.patches?.[0]?.newContent, "after");
});

test("normalizeLegacySingleFileEdit fills missing filePath for a single patch candidate", () => {
  const result = normalizeLegacySingleFileEdit(
    JSON.stringify({
      status: "patch",
      summary: "legacy single patch edit",
      patches: [
        {
          oldContent: "before",
          newContent: "after",
          summary: "update selected file"
        }
      ]
    }),
    "src/App.vue"
  );

  assert.equal(result?.patches?.[0]?.filePath, "src/App.vue");
  assert.equal(result?.patches?.[0]?.oldContent, "before");
  assert.equal(result?.patches?.[0]?.newContent, "after");
});

test("normalizeLegacySingleFileEdit refuses ambiguous candidate files", () => {
  const result = normalizeLegacySingleFileEdit(
    JSON.stringify({
      status: "patch",
      summary: "legacy single file edit",
      newContent: "after"
    }),
    null,
    ["src/App.vue", "src/Header.vue"]
  );

  assert.equal(result, null);
});
test("parseAiEditResult accepts common file path aliases", () => {
  const result = parseAiEditResult(
    JSON.stringify({
      status: "patch",
      summary: "update app",
      patches: [
        {
          targetPath: "src/App.vue",
          oldContent: "before",
          newContent: "after",
          summary: "rewrite app"
        }
      ]
    })
  );

  assert.equal(result.patches?.[0]?.filePath, "src/App.vue");
});

test("parseAiEditResult rejects top-level newContent without an inferable file path", () => {
  assert.throws(
    () =>
      parseAiEditResult(
        JSON.stringify({
          status: "patch",
          summary: "legacy edit without target",
          newContent: "after"
        })
      ),
    (error) => error instanceof HttpError && error.status === 502 && error.message.includes("patches[].filePath")
  );
});
