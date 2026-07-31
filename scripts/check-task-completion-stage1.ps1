$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Task Completion Stage 1] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    $testStep = @{
        Title = "file edit no-op write regressions"
        Arguments = @(
            "--dir", "apps/server",
            "exec", "tsx", "--test",
            "src/fileEditService.test.ts",
            "src/fileTools.test.ts"
        )
    }
    Invoke-VerificationStep @testStep

    $typecheckStep = @{
        Title = "server typecheck"
        Arguments = @("--dir", "apps/server", "typecheck")
    }
    Invoke-VerificationStep @typecheckStep

    Write-Host "`nTask completion stage 1 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
