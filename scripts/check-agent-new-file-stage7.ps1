$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-VerificationStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "`n[Agent New File] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Title failed with exit code $LASTEXITCODE"
    }
}

Push-Location $repoRoot
try {
    Invoke-VerificationStep `
        -Title "new-file end-to-end acceptance" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "test:agent-new-file-stage7"
        )

    Invoke-VerificationStep `
        -Title "existence and workflow regressions" `
        -Arguments @(
            "--filter", "@mini-ai-web-editor/server",
            "exec", "tsx", "--test",
            "src/existenceChecker/existenceChecker.test.ts",
            "src/existenceChecker/packageResolver.test.ts",
            "src/existenceChecker/aliasResolver.test.ts",
            "src/existenceChecker/plannedFileResolver.test.ts",
            "src/taskWorkflow/decisionPolicy.test.ts",
            "src/agentCompletionPolicy.test.ts",
            "src/agentRuntime.test.ts",
            "src/agentPatchTools.test.ts",
            "src/agentFileEditTools.test.ts",
            "src/featureFlags.test.ts"
        )

    Invoke-VerificationStep `
        -Title "server full regression" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "test")

    Invoke-VerificationStep `
        -Title "server typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/server", "typecheck")

    Invoke-VerificationStep `
        -Title "web typecheck" `
        -Arguments @("--filter", "@mini-ai-web-editor/web", "typecheck")

    Invoke-VerificationStep `
        -Title "web production build" `
        -Arguments @("--filter", "@mini-ai-web-editor/web", "build")

    Write-Host "`nAgent new-file autonomy stage 7 acceptance passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
