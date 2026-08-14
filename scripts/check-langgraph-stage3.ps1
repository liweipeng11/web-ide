$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[LangGraph Stage 3] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    # Keep this script ASCII-compatible because Windows PowerShell 5 reads UTF-8 without BOM as ANSI.
    Invoke-PnpmStep -Title "1/4 cumulative stage 2 gate" -Arguments @("verify:langgraph-stage2")
    Invoke-PnpmStep -Title "2/4 planning graph and reducers" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/planning/*.test.ts"
    )
    Invoke-PnpmStep -Title "3/4 main runtime integration" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "test:main-agent"
    )
    Invoke-PnpmStep -Title "4/4 server typecheck" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "typecheck"
    )
    Write-Host "`nLangGraph stage 3 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
