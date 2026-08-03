$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Task Completion Stage 7] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep -Title "task completion end-to-end acceptance" -Arguments @(
        "--dir", "apps/server", "test:task-completion-stage7"
    )
    Invoke-VerificationStep -Title "completion evidence regression suite" -Arguments @(
        "--dir", "apps/server", "test:agent-new-file-stage4"
    )
    Invoke-VerificationStep -Title "server typecheck" -Arguments @(
        "--dir", "apps/server", "typecheck"
    )
    Invoke-VerificationStep -Title "web typecheck" -Arguments @(
        "--dir", "apps/web", "typecheck"
    )
    Invoke-VerificationStep -Title "web production build" -Arguments @(
        "--dir", "apps/web", "build"
    )
    Invoke-VerificationStep -Title "full repository tests" -Arguments @("test")

    Write-Host "`nTask completion stage 7 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
