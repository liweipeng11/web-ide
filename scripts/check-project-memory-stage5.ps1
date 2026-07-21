$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 验证管理 API、规则提升流程和前后端数据契约
    & pnpm.cmd --filter "@mini-ai-web-editor/server" exec tsx --test "src/projectMemory/projectMemoryRoutes.test.ts" "src/projectMemory/memoryPromotionService.test.ts" "src/contracts/projectMemoryContract.test.ts"
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
