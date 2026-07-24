$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/agentRuntime.test.ts `
        src/agentBudgetPolicy.test.ts `
        src/prompts.test.ts `
        src/codeDiscovery/codeDiscovery.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
