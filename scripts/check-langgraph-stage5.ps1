$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n[LangGraph Stage 5] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Title failed with exit code $LASTEXITCODE" }
}

Push-Location $repoRoot
try {
    Invoke-PnpmStep -Title "1/7 cumulative stage 4 gate" -Arguments @("verify:langgraph-stage4")
    Invoke-PnpmStep -Title "2/7 Developer Patch-only tests" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/developer/*.test.ts"
    )
    Invoke-PnpmStep -Title "3/7 Patch Store, Diff and Safe Editor contracts" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/patchStore.test.ts", "src/diffTools.test.ts", "src/safeEditor/plannedChanges.test.ts",
        "src/safeEditor/safeEditor.test.ts", "src/patchApplyService.test.ts"
    )
    Invoke-PnpmStep -Title "4/7 stage 5 acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/langGraphStage5Acceptance.test.ts"
    )
    Invoke-PnpmStep -Title "5/7 server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Invoke-PnpmStep -Title "6/7 web typecheck" -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")
    Invoke-PnpmStep -Title "7/7 web production build" -Arguments @("--filter", "@mini-ai-web-editor/web", "build")
    Write-Host "`nLangGraph stage 5 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}

