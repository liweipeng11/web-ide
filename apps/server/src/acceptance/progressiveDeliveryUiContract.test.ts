import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const webSourceRoot = path.resolve(testDirectory, "../../../web/src");

test("阶段 5：渐进交付界面保留恢复入口与旧会话降级", async () => {
  const [planPanel, stepsPanel, chatPanel, chatHook] = await Promise.all([
    fs.readFile(path.join(webSourceRoot, "components/TaskPlanPanel.tsx"), "utf8"),
    fs.readFile(path.join(webSourceRoot, "components/chat/AgentStepsPanel.tsx"), "utf8"),
    fs.readFile(path.join(webSourceRoot, "components/ChatPanel.tsx"), "utf8"),
    fs.readFile(path.join(webSourceRoot, "hooks/useChatSession.ts"), "utf8")
  ]);

  assert.match(planPanel, /deliveryUnits \|\| \[\]/, "旧会话缺少交付单元时应继续渲染原计划");
  assert.match(planPanel, /shouldShowPlanSteps/, "交付单元存在时应按需展开来源计划");
  assert.match(planPanel, /查看计划步骤/);
  assert.match(planPanel, /按当前事实重规划/);
  assert.match(planPanel, /编辑计划后继续/);
  assert.match(planPanel, /等待你的决策/);
  assert.match(stepsPanel, /工具失败诊断/);
  assert.match(stepsPanel, /参数摘要/);
  assert.match(stepsPanel, /查看全部历史/);
  assert.match(chatPanel, /onOpenTaskConversation/);
  assert.match(chatHook, /resumeTaskSessionChat/);
  assert.match(chatHook, /resumableSession\?\.id/, "用户决策应通过原任务会话恢复，而非在前端伪造终态");
});
