$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Safe Editor Stage 6] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "Safe Editor end-to-end and focused regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
            "src/safeEditor/impactPreflight.test.ts",
            "src/safeEditor/modificationPlan.test.ts",
            "src/safeEditor/plannedChanges.test.ts",
            "src/safeEditor/safeEditor.test.ts",
            "src/impactAnalyzer/impactAnalyzer.test.ts",
            "src/taskWorkflow/decisionPolicy.test.ts",
            "src/agentPatchTools.test.ts",
            "src/editPatchService.test.ts",
            "src/agentRuntime.test.ts",
            "src/featureFlags.test.ts",
            "src/observability/runMetrics.test.ts",
            "src/acceptance/safeEditorEndToEnd.test.ts"
        )

    Invoke-VerificationStep -Title "server full regression" -Arguments @("--filter", "@mini-ai-web-editor/server", "test")
    Invoke-VerificationStep -Title "server typecheck" -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")
    Invoke-VerificationStep -Title "web typecheck" -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")
    Invoke-VerificationStep -Title "web production build" -Arguments @("--filter", "@mini-ai-web-editor/web", "build")
    Invoke-VerificationStep -Title "agent new-file stage 0-7 regression" -Arguments @("verify:agent-new-file-stage7")

    Write-Host "`nSafe Editor stage 6 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
