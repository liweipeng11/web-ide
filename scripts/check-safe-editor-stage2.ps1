$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Safe Editor Stage 2] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "structured modification plan and Safe Editor regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/safeEditor/plannedChanges.test.ts",
            "src/safeEditor/modificationPlan.test.ts",
            "src/editScope.test.ts",
            "src/agentPatchTools.test.ts",
            "src/aiClient.test.ts",
            "src/safeEditor/safeEditor.test.ts",
            "src/acceptance/safeEditorScopeBaseline.test.ts",
            "src/patchApplyService.test.ts",
            "src/prompts.test.ts"
        )

    Invoke-VerificationStep `
        -Title "server typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")

    Invoke-VerificationStep `
        -Title "web typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")

    Write-Host "`nSafe Editor stage 2 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
