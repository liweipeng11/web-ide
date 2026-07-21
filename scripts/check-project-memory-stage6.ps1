$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 先运行安全、确定性评测、聚合指标和灰度开关专项测试。
    & pnpm.cmd --filter "@mini-ai-web-editor/server" run test:project-memory-stage6
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    # 最终阶段执行服务端完整回归、双端类型检查和前端生产构建。
    & pnpm.cmd --filter "@mini-ai-web-editor/server" test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/server" typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/web" typecheck
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    & pnpm.cmd --filter "@mini-ai-web-editor/web" build
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
