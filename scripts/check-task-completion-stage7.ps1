$ErrorActionPreference = "Stop"

# 阶段七先跑 12 项离线端到端场景，再执行阶段四关键回归与全仓验证。
pnpm --dir apps/server test:task-completion-stage7
pnpm --dir apps/server test:agent-new-file-stage4
pnpm --dir apps/server typecheck
pnpm --dir apps/web typecheck
pnpm --dir apps/web build
pnpm test

Write-Host "Task completion stage 7 checks passed."
