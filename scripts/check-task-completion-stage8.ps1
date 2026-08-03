$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-StageScript {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$ScriptPath
    )

    Write-Host "`n[Task Completion Stage 8] $Title" -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File $ScriptPath
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Task Completion Stage 8] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    # Keep this script ASCII-compatible because Windows PowerShell 5 reads UTF-8 without BOM as ANSI.
    $stageScripts = @(
        @{ Title = "completion evidence persistence"; Path = "scripts/check-task-completion-evidence-persistence.ps1" },
        @{ Title = "completion rejection convergence"; Path = "scripts/check-complete-task-convergence.ps1" },
        @{ Title = "completion status presentation"; Path = "scripts/check-completion-status-presentation.ps1" },
        @{ Title = "task completion observability"; Path = "scripts/check-task-completion-observability.ps1" },
        @{ Title = "state storage integrity"; Path = "scripts/check-state-storage-integrity.ps1" }
    )
    foreach ($stage in $stageScripts) {
        Invoke-StageScript -Title $stage.Title -ScriptPath (Join-Path $repoRoot $stage.Path)
    }

    Invoke-PnpmStep -Title "stage 6 end-to-end acceptance and rollout tests" -Arguments @(
        "--dir", "apps/server", "test:task-completion-stage7"
    )
    Invoke-PnpmStep -Title "full server regression suite" -Arguments @("--dir", "apps/server", "test")
    Invoke-PnpmStep -Title "server typecheck" -Arguments @("--dir", "apps/server", "typecheck")
    Invoke-PnpmStep -Title "web typecheck" -Arguments @("--dir", "apps/web", "typecheck")
    Invoke-PnpmStep -Title "web production build" -Arguments @("--dir", "apps/web", "build")
    Invoke-PnpmStep -Title "previous stage compatibility" -Arguments @("verify:task-completion-stage7")

    Write-Host "`nTask completion Stage 8 full acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
