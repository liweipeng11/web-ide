$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Invoke-PnpmStep {
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    Write-Host "`n[LangGraph Stage 7] $Title" -ForegroundColor Cyan
    & pnpm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Title failed with exit code $LASTEXITCODE" }
}

Push-Location $repoRoot
try {
    Invoke-PnpmStep -Title "1/8 cumulative stage 6 gate" -Arguments @("verify:langgraph-stage6")
    Invoke-PnpmStep -Title "2/8 Tester Graph and verifier contracts" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/langgraph/tester/*.test.ts", "src/verifier/*.test.ts", "src/agents/tester/*.test.ts"
    )
    Invoke-PnpmStep -Title "3/8 completion policy and finalizer contracts" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/agentCompletionPolicy.test.ts", "src/agentCompletionTools.test.ts", "src/taskSessionFinalizer.test.ts"
    )
    Invoke-PnpmStep -Title "4/8 stage 7 acceptance" -Arguments @(
        "--filter", "@mini-ai-web-editor/server", "exec", "tsx", "--test",
        "src/acceptance/langGraphStage7Acceptance.test.ts"
    )
    Invoke-PnpmStep -Title "5/8 runtime phase 8" -Arguments @("verify:runtime-phase8")
    Invoke-PnpmStep -Title "6/8 new-file and task-completion acceptance" -Arguments @(
        "verify:agent-new-file-stage7"
    )
    Invoke-PnpmStep -Title "7/8 task completion acceptance" -Arguments @("verify:task-completion-stage8")
    Invoke-PnpmStep -Title "8/8 safe editor acceptance" -Arguments @("verify:safe-editor-stage6")
    Write-Host "`nLangGraph stage 7 verification passed." -ForegroundColor Green
}
finally {
    Pop-Location
}
