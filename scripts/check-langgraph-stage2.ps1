$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[LangGraph Stage 2] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    # Keep this script ASCII-compatible because Windows PowerShell 5 reads UTF-8 without BOM as ANSI.
    Invoke-PnpmStep -Title "1/4 cumulative stage 0 gate" -Arguments @("verify:langgraph-stage0")

    Invoke-PnpmStep -Title "2/4 stage 2 read-only safety acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/langGraphStage2Acceptance.test.ts"
    )

    Invoke-PnpmStep -Title "3/4 direct entry and rollout regression" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/agentOrchestrationService.test.ts",
        "src/langgraph/rollout/*.test.ts"
    )

    Invoke-PnpmStep -Title "4/4 server typecheck" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "typecheck"
    )

    Write-Host "`nLangGraph stage 2 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
