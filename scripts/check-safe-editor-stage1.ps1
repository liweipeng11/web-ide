$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Safe Editor Stage 1] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "status semantics and application gate regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/safeEditor/safeEditor.test.ts",
            "src/acceptance/safeEditorScopeBaseline.test.ts",
            "src/patchApplyService.test.ts"
        )

    Invoke-VerificationStep `
        -Title "server typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")

    Invoke-VerificationStep `
        -Title "web typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")

    Write-Host "`nSafe Editor stage 1 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
