import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "./errors.js";
import { applySearchReplaceEdits, resolvePatchNewContent } from "./searchReplacePatch.js";

test("applySearchReplaceEdits applies an exact local replacement", () => {
  const result = applySearchReplaceEdits("src/App.vue", "before\n<nav>Home</nav>\nafter\n", [
    {
      search: "<nav>Home</nav>",
      replace: "<nav>Home Tools</nav>"
    }
  ]);

  assert.equal(result, "before\n<nav>Home Tools</nav>\nafter\n");
});

test("applySearchReplaceEdits rejects ambiguous replacements by default", () => {
  assert.throws(
    () =>
      applySearchReplaceEdits("src/App.vue", "item\nitem\n", [
        {
          search: "item",
          replace: "updated"
        }
      ]),
    /matched a search block 2 times/
  );
});

test("resolvePatchNewContent rejects stale full-file rewrites", () => {
  assert.throws(
    () =>
      resolvePatchNewContent(
        "src/App.vue",
        {
          filePath: "src/App.vue",
          oldContent: "old snapshot",
          newContent: "new snapshot",
          summary: "rewrite"
        },
        "current file",
        "增加导航"
      ),
    (error) => error instanceof HttpError && error.status === 422 && /stale or incomplete/.test(error.message)
  );
});

test("resolvePatchNewContent allows focused local edits", () => {
  const result = resolvePatchNewContent(
    "src/App.vue",
    {
      filePath: "src/App.vue",
      oldContent: "",
      newContent: "",
      summary: "add nav item",
      edits: [
        {
          search: "<nav>Home</nav>",
          replace: "<nav>Home Tools</nav>"
        }
      ]
    },
    "before\n<nav>Home</nav>\nafter\n",
    "增加一个导航"
  );

  assert.equal(result, "before\n<nav>Home Tools</nav>\nafter\n");
});

test("resolvePatchNewContent blocks risky removals for non-destructive requests", () => {
  const previousContent = Array.from({ length: 100 }, (_item, index) => `line ${index + 1}`).join("\n");
  const newContent = Array.from({ length: 10 }, (_item, index) => `line ${index + 1}`).join("\n");

  assert.throws(
    () =>
      resolvePatchNewContent(
        "src/App.vue",
        {
          filePath: "src/App.vue",
          oldContent: previousContent,
          newContent,
          summary: "add nav"
        },
        previousContent,
        "增加一个导航"
      ),
    (error) => error instanceof HttpError && error.status === 422 && /removes/.test(error.message)
  );
});
