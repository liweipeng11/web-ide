$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Safe Editor Stage 5] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "front-end Safe Editor contract" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test", "src/acceptance/safeEditorUiContract.test.ts")

    Invoke-VerificationStep -Title "server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Invoke-VerificationStep -Title "web typecheck" -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")
    Invoke-VerificationStep -Title "web production build" -Arguments @("--filter", "@mini-ai-web-editor/web", "build")

    Write-Host "`nSafe Editor stage 5 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}

