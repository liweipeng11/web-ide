$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

try {
    # 验证候选记忆、抽取校验、去重、安全过滤和 HTTP API。
    pnpm --filter @mini-ai-web-editor/server exec tsx --test src/projectMemory/memoryCandidateService.test.ts src/projectMemory/memoryExtractionService.test.ts src/projectMemory/memorySanitizer.test.ts src/projectMemory/projectMemoryRoutes.test.ts

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
