$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Task Plan Runtime Sync] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    # Keep this script ASCII-compatible because Windows PowerShell 5 reads UTF-8 without BOM as ANSI.
    Invoke-PnpmStep -Title "1/9 task plan state tests" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/taskSessionStore.test.ts"
    )

    Invoke-PnpmStep -Title "2/9 runtime mutation and validation event tests" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/agentRuntime.test.ts",
        "src/agentCommandTools.test.ts"
    )

    Invoke-PnpmStep -Title "3/9 approval resume end-to-end tests" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/agentTaskCompletionAcceptance.test.ts"
    )

    Invoke-PnpmStep -Title "4/9 completion gate and metrics tests" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/agentCompletionPolicy.test.ts",
        "src/taskSessionFinalizer.test.ts",
        "src/observability/runMetrics.test.ts"
    )

    Invoke-PnpmStep -Title "5/9 persisted state integrity" -Arguments @(
        "verify:state-storage-integrity"
    )

    Invoke-PnpmStep -Title "6/9 route creation end-to-end acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "test:agent-new-file-stage7"
    )

    Invoke-PnpmStep -Title "7/9 server typecheck" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "typecheck"
    )

    Invoke-PnpmStep -Title "8/9 web typecheck" -Arguments @(
        "--filter", "@mini-ai-web-editor/web", "typecheck"
    )
    Invoke-PnpmStep -Title "8/9 web production build" -Arguments @(
        "--filter", "@mini-ai-web-editor/web", "build"
    )

    Invoke-PnpmStep -Title "9/9 full server regression" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "test"
    )

    Write-Host "`nTask plan/runtime sync release gate passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
