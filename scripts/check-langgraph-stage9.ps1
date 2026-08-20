$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n[LangGraph Stage 9] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Title failed with exit code $LASTEXITCODE" }
}

Push-Location $repoRoot
try {
    Invoke-PnpmStep -Title "1/7 cumulative stage 8 gate" -Arguments @("verify:langgraph-stage8")
    Invoke-PnpmStep -Title "2/7 rollout contracts and safety gates" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/rollout/*.test.ts", "src/agentOrchestrationService.test.ts"
    )
    Invoke-PnpmStep -Title "3/7 stage 9 rollback acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/langGraphStage9Acceptance.test.ts"
    )
    Invoke-PnpmStep -Title "4/7 server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Invoke-PnpmStep -Title "5/7 server LangGraph suite" -Arguments @("--filter", "@mini-ai-web-editor/server", "test:langgraph")
    Invoke-PnpmStep -Title "6/7 web typecheck" -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")
    Invoke-PnpmStep -Title "7/7 web production build" -Arguments @("--filter", "@mini-ai-web-editor/web", "build")
    Write-Host "`nLangGraph stage 9 automated verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
