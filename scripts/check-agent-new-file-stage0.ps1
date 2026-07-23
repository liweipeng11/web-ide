$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

try {
    & pnpm.cmd --filter "@mini-ai-web-editor/server" test:agent-new-file-stage0
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
