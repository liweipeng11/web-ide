$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[LangGraph Stage 0] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    # Keep this script ASCII-compatible because Windows PowerShell 5 reads UTF-8 without BOM as ANSI.
    Invoke-PnpmStep -Title "1/4 deterministic legacy baseline" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/testing/baselineScenarios.test.ts",
        "src/langgraph/testing/legacyBaselineRunner.test.ts",
        "src/acceptance/langGraphStage0Acceptance.test.ts"
    )

    Invoke-PnpmStep -Title "2/4 feature flag and legacy fallback" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/featureFlags.test.ts",
        "src/agentOrchestrationService.test.ts"
    )

    Invoke-PnpmStep -Title "3/4 server typecheck" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "typecheck"
    )

    Invoke-PnpmStep -Title "4/4 focused LangGraph regression" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "test:langgraph"
    )

    Write-Host "`nLangGraph stage 0 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
