$ErrorActionPreference = "Stop"

# 阶段四集中验证完成策略、Runtime 证据采集、工作流状态持久化与指标输出。
pnpm --dir apps/server run test:agent-new-file-stage4
pnpm --dir apps/server typecheck

Write-Host "Task completion stage 4 checks passed."
