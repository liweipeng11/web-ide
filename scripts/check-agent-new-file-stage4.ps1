$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/agentCompletionPolicy.test.ts `
        src/agentRuntime.test.ts `
        src/taskWorkflow/taskWorkflowEngine.test.ts `
        src/taskSessionStore.test.ts `
        src/observability/runMetrics.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
