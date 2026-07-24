$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Safe Editor Stage 0] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "scope baseline and Safe Editor regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/safeEditor/safeEditor.test.ts",
            "src/acceptance/safeEditorScopeBaseline.test.ts"
        )

    Invoke-VerificationStep `
        -Title "server typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")

    Write-Host "`nSafe Editor stage 0 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
