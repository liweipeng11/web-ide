$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    # Keep this script ASCII-compatible because Windows PowerShell 5 reads UTF-8 without BOM as ANSI.
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/agentRuntime.test.ts `
        src/agentCommandTools.test.ts `
        src/taskSessionStore.test.ts `
        src/acceptance/agentTaskCompletionAcceptance.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
