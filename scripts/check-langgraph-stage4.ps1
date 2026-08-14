$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n[LangGraph Stage 4] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Title failed with exit code $LASTEXITCODE" }
}

Push-Location $repoRoot
try {
    Invoke-PnpmStep -Title "1/4 cumulative stage 3 gate" -Arguments @("verify:langgraph-stage3")
    Invoke-PnpmStep -Title "2/4 persistence interrupt and event tests" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/persistence/*.test.ts", "src/langgraph/events/*.test.ts", "src/langgraph/interrupts/*.test.ts"
    )
    Invoke-PnpmStep -Title "3/4 stage 4 acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/langGraphStage4Acceptance.test.ts"
    )
    Invoke-PnpmStep -Title "4/4 server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Write-Host "`nLangGraph stage 4 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}

