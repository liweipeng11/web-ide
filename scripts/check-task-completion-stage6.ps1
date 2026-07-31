$ErrorActionPreference = "Stop"

# 阶段六聚焦任务会话合并写、内容去重、关键状态刷新和持久化指标。
pnpm --dir apps/server exec tsx --test src/taskSessionStore.test.ts src/observability/taskMetrics.test.ts src/agentFileEditTools.test.ts

pnpm --dir apps/server typecheck

Write-Host "Task completion stage 6 checks passed."
