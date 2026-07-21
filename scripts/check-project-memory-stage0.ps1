$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 验证当前 Project Memory 的存储、服务、提示词和模型入口注入基线。
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
