$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n[LangGraph Stage 6] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Title failed with exit code $LASTEXITCODE" }
}

Push-Location $repoRoot
try {
    Invoke-PnpmStep -Title "1/5 cumulative stage 5 gate" -Arguments @("verify:langgraph-stage5")
    Invoke-PnpmStep -Title "2/5 approval, apply and recovery contracts" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/patchApplication/*.test.ts", "src/langgraph/interrupts/*.test.ts"
    )
    Invoke-PnpmStep -Title "3/5 checkpoint, Patch Apply and rollback contracts" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/checkpointStore.test.ts", "src/patchApplyService.test.ts"
    )
    Invoke-PnpmStep -Title "4/5 server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Invoke-PnpmStep -Title "5/5 state storage integrity" -Arguments @("verify:state-storage-integrity")
    Write-Host "`nLangGraph stage 6 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
