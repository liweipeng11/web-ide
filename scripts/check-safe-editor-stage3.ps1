$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Safe Editor Stage 3] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "dynamic impact preflight and regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/impactAnalyzer/impactAnalyzer.test.ts",
            "src/safeEditor/impactPreflight.test.ts",
            "src/safeEditor/safeEditor.test.ts",
            "src/taskWorkflow/decisionPolicy.test.ts",
            "src/agentPatchTools.test.ts"
        )

    Invoke-VerificationStep `
        -Title "server typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")

    Write-Host "`nSafe Editor stage 3 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
