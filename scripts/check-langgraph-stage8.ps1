$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n[LangGraph Stage 8] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Title failed with exit code $LASTEXITCODE" }
}

Push-Location $repoRoot
try {
    Invoke-PnpmStep -Title "1/7 cumulative stage 7 gate" -Arguments @("verify:langgraph-stage7")
    Invoke-PnpmStep -Title "2/7 Main Graph and TaskSession contracts" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/main/*.test.ts", "src/agentOrchestrationService.test.ts"
    )
    Invoke-PnpmStep -Title "3/7 events, approval and restart recovery" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/events/*.test.ts", "src/langgraph/interrupts/*.test.ts", "src/langgraph/persistence/*.test.ts"
    )
    Invoke-PnpmStep -Title "4/7 stage 8 acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/langGraphStage8Acceptance.test.ts"
    )
    Invoke-PnpmStep -Title "5/7 server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Invoke-PnpmStep -Title "6/7 web typecheck" -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")
    Invoke-PnpmStep -Title "7/7 web production build" -Arguments @("--filter", "@mini-ai-web-editor/web", "build")
    Write-Host "`nLangGraph stage 8 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
