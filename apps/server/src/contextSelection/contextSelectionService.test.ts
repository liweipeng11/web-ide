import assert from "node:assert/strict";
import test from "node:test";
import { createContextSelectionSnapshot, formatContextSelectionNeed } from "./contextSelectionService.js";

test("context selection blocks patch when only search results exist", () => {
  const snapshot = createContextSelectionSnapshot({
    userGoal: "修改用户列表接口字段",
    searchResultFiles: ["src/services/userApi.ts"]
  });

  assert.equal(snapshot.readyForPatch, false);
  assert.equal(snapshot.missingRequirements.some((item) => item.requirement === "read-core-file"), true);
});

test("context selection allows local copy change after selected file is read", () => {
  const snapshot = createContextSelectionSnapshot({
    userGoal: "把按钮文案改成保存",
    selectedFilePath: "src/components/UserButton.tsx",
    filesRead: ["src/components/UserButton.tsx"]
  });

  assert.equal(snapshot.readyForPatch, true);
  assert.equal(snapshot.requiredCompanions.length, 0);
});

test("context selection requires companion context for api changes until enough files are read", () => {
  const blocked = createContextSelectionSnapshot({
    userGoal: "修改 api 返回字段名称",
    selectedFilePath: "src/api.ts",
    filesRead: ["src/api.ts"]
  });

  assert.equal(blocked.readyForPatch, false);
  assert.equal(blocked.requiredCompanions.some((item) => item.requiredBy === "api-service-change"), true);

  const ready = createContextSelectionSnapshot({
    userGoal: "修改 api 返回字段名称",
    selectedFilePath: "src/api.ts",
    filesRead: ["src/api.ts", "src/components/UserPanel.tsx"]
  });

  assert.equal(ready.readyForPatch, true);
});

test("context selection formats next search directions for missing companions", () => {
  const snapshot = createContextSelectionSnapshot({
    userGoal: "重命名组件 props",
    selectedFilePath: "src/components/UserCard.tsx",
    filesRead: ["src/components/UserCard.tsx"]
  });
  const need = formatContextSelectionNeed(snapshot);

  assert.equal(snapshot.readyForPatch, false);
  assert.ok(need.nextSearchKeywords.includes("parent-components-types-or-hooks"));
});
