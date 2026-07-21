$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 验证旧版本迁移以及 Rules、Snapshot 与 Memory 的安全边界。
    pnpm --filter @mini-ai-web-editor/server test:project-memory
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    pnpm --filter @mini-ai-web-editor/server typecheck
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }

    pnpm --filter @mini-ai-web-editor/web typecheck
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
