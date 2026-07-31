$ErrorActionPreference = "Stop"

# 阶段五聚焦统一终态出口，并回归 Runtime、验证与任务会话持久化。
pnpm --dir apps/server exec tsx --test src/taskSessionFinalizer.test.ts src/taskSessionStore.test.ts src/taskWorkflow/taskWorkflowEngine.test.ts src/autoValidationService.test.ts src/agentRuntime.test.ts

pnpm --dir apps/server typecheck

Write-Host "Task completion stage 5 checks passed."
