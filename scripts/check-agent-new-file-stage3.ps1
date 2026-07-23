$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test `
        src/taskWorkflow/decisionPolicy.test.ts `
        src/agentRuntime.test.ts `
        src/agentTools.test.ts `
        src/agentFileEditTools.test.ts `
        src/agentPatchTools.test.ts
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
